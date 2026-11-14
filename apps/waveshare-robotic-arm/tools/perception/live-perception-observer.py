"""Finite read-only camera diagnostics. No image bytes or recordings are saved.

Keeps current, previous, and trial-reference grayscale images in memory. Emits scalar
motion measurements and fresh-frame metadata; never connects to the robot.
Image change is not calibrated joint pose, clearance, or human supervision.
"""
from datetime import datetime, timezone
from pathlib import Path
import argparse
import json
import itertools
import math
import re
import time
import urllib.request

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
# Current fixed camera: broad arm region, normalized to image dimensions.
# This is an explicitly selected image region, not automatic object recognition.
ARM_ROI = (0.38, 0.17, 0.28, 0.43)
FOREARM_ROI = (0.345, 0.325, 0.19, 0.14)
# Manually selected tool-end patch in this fixed camera view, not segmentation.
TIP_ROI = (0.35, 0.35, 0.075, 0.105)


def timestamp(value):
    at = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if at.tzinfo is None:
        raise ValueError('Camera timestamp must include its timezone')
    return at.timestamp()


def motion_metrics(previous, current, roi=ARM_ROI):
    if previous.shape != current.shape or len(current.shape) != 2:
        raise ValueError('Matching grayscale images required')
    height, width = current.shape
    x, y, w, h = roi
    if not all(math.isfinite(v) for v in roi) or min(x, y) < 0 or min(w, h) <= 0 or x+w > 1 or y+h > 1:
        raise ValueError('Bounded normalized image region required')
    mask = np.zeros(current.shape, dtype=bool)
    mask[int(y*height):int((y+h)*height), int(x*width):int((x+w)*width)] = True
    if not np.any(mask) or np.all(mask):
        raise ValueError('Arm region and outside region both required')
    signed = current.astype(np.float32) - previous.astype(np.float32)
    # Remove a uniform exposure shift using the region outside the arm box.
    exposure = float(np.median(signed[~mask]))
    delta = np.abs(signed-exposure)
    changed = delta >= 12
    return {
        'armChangedFraction': float(np.mean(changed[mask])),
        'outsideChangedFraction': float(np.mean(changed[~mask])),
        'armMeanAbsoluteChange': float(np.mean(delta[mask])),
        'outsideMeanAbsoluteChange': float(np.mean(delta[~mask])),
        'exposureShiftGray': exposure,
    }


def fit_fixed_anchor_affine(reference, current, anchor, background=(0., 0.), threshold=.35):
    p, q = np.asarray(reference, dtype=np.float64), np.asarray(current, dtype=np.float64)
    c, bg = np.asarray(anchor, dtype=np.float64), np.asarray(background, dtype=np.float64)
    unknown = {'valid': False, 'estimator': 'fixed-anchor-affine-v1', 'displacementPixels': None,
               'inliers': 0, 'tracks': len(p), 'fitRmsPixels': None,
               'referenceCentroidPixels': None, 'referenceSpreadPixels': None,
               'inlierCentroidPixels': None, 'inlierSpreadPixels': None,
               'inlierSpatialCondition': None, 'anchorOutsideHullPixels': None,
               'jacobian': None, 'reason': 'insufficient-support'}
    if p.shape != q.shape or p.ndim != 2 or p.shape[1] != 2 or not 6 <= len(p) <= 100 or c.shape != (2,) or bg.shape != (2,):
        return unknown
    if not all(np.all(np.isfinite(v)) for v in (p, q, c, bg)):
        return {**unknown, 'reason': 'nonfinite-input'}
    center = p.mean(axis=0)
    spread = float(np.sqrt(np.mean(np.sum((p-center)**2, axis=1))))
    unknown.update(referenceCentroidPixels=center.tolist(), referenceSpreadPixels=spread)
    if spread < 3.:
        return {**unknown, 'reason': 'insufficient-spatial-spread'}
    design = np.column_stack((p-c, np.ones(len(p))))
    target = q-p-bg

    def solve(indices):
        value, _, rank, _ = np.linalg.lstsq(design[indices], target[indices], rcond=None)
        return value if rank == 3 else None

    if math.comb(len(p), 3) <= 512:
        hypotheses = itertools.combinations(range(len(p)), 3)
    else:
        rng = np.random.default_rng(0)
        hypotheses = (tuple(sorted(rng.choice(len(p), 3, replace=False))) for _ in range(512))
    best = None
    for triple in hypotheses:
        indices = list(triple)
        triangle = p[indices]-p[indices[0]]
        twice_area = abs(float(triangle[1, 0]*triangle[2, 1]-triangle[1, 1]*triangle[2, 0]))
        if twice_area < 4.:
            continue
        value = solve(indices)
        if value is None:
            continue
        residual = np.linalg.norm(design@value-target, axis=1)
        mask = residual <= threshold
        score = (int(mask.sum()), -float(np.median(residual)))
        if best is None or score > best[0]:
            best = (score, mask)
        # Every full-consensus hypothesis selects the same complete point set.
        # The following least-squares refits are therefore identical; no later
        # hypothesis can improve support or change the final fitted result.
        if bool(np.all(mask)):
            break
    required = max(6, math.ceil(.65*len(p)))
    if best is None or best[0][0] < required:
        return unknown
    mask = best[1]
    for _ in range(2):
        value = solve(np.flatnonzero(mask))
        if value is None:
            return {**unknown, 'reason': 'degenerate-inlier-fit'}
        residual = np.linalg.norm(design@value-target, axis=1)
        mask = residual <= threshold
        if int(mask.sum()) < required:
            return {**unknown, 'reason': 'insufficient-final-support'}
    inliers = p[mask]
    inlier_center = inliers.mean(axis=0)
    singular = np.linalg.svd(inliers-inlier_center, compute_uv=False)
    condition = float(singular[0]/singular[-1]) if singular[-1] > 0 else math.inf
    if singular[-1] < 1. or condition > 50.:
        return {**unknown, 'reason': 'degenerate-inlier-spread'}
    hull = cv2.convexHull(inliers.astype(np.float32))
    outside = max(0., -cv2.pointPolygonTest(hull, tuple(c), True))
    return {**unknown, 'valid': True, 'reason': 'supported-local-affine-fit',
            'displacementPixels': value[2].tolist(), 'inliers': int(mask.sum()),
            'fitRmsPixels': float(np.sqrt(np.mean(residual[mask]**2))),
            'inlierCentroidPixels': inlier_center.tolist(),
            'inlierSpreadPixels': float(np.sqrt(np.mean(np.sum((inliers-inlier_center)**2, axis=1)))),
            'inlierSpatialCondition': condition, 'anchorOutsideHullPixels': float(outside),
            'jacobian': (np.eye(2)+value[:2].T).tolist()}



def tracked_motion(previous, current, roi=ARM_ROI, include_affine=False):
    """Subpixel image displacement, corrected for median background movement.

    This tracks image corners, not named robot parts. No conversion to angles,
    collision inference, or permission to command the arm is made here.
    """
    if previous.shape != current.shape or len(current.shape) != 2 or previous.dtype != np.uint8 or current.dtype != np.uint8:
        raise ValueError('Matching uint8 grayscale images required')
    height, width = current.shape
    x, y, w, h = roi
    if not all(math.isfinite(v) for v in roi) or min(x, y) < 0 or min(w, h) <= 0 or x+w > 1 or y+h > 1:
        raise ValueError('Bounded normalized image region required')
    mask = np.zeros(current.shape, dtype=np.uint8)
    mask[int(y*height):int((y+h)*height), int(x*width):int((x+w)*width)] = 255
    if not np.any(mask) or np.all(mask):
        raise ValueError('Arm region and outside region both required')

    arm_points = None

    def tracks(region, keep_points=False):
        nonlocal arm_points
        points = cv2.goodFeaturesToTrack(previous, maxCorners=100, qualityLevel=.015, minDistance=5, mask=region, blockSize=5)
        if points is None:
            return np.empty((0, 2), dtype=np.float32)
        params = dict(winSize=(15, 15), maxLevel=2,
                      criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, .01))
        forward, valid, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None, **params)
        if forward is None:
            return np.empty((0, 2), dtype=np.float32)
        backward, valid_back, _ = cv2.calcOpticalFlowPyrLK(current, previous, forward, None, **params)
        if backward is None:
            return np.empty((0, 2), dtype=np.float32)
        a, b, back = points.reshape(-1, 2), forward.reshape(-1, 2), backward.reshape(-1, 2)
        okay = ((valid.ravel() == 1) & (valid_back.ravel() == 1) &
                np.all(np.isfinite(b), axis=1) & np.all(np.isfinite(back), axis=1) &
                (np.linalg.norm(back-a, axis=1) <= .7) &
                (b[:, 0] >= 0) & (b[:, 0] < width) & (b[:, 1] >= 0) & (b[:, 1] < height))
        if keep_points:
            arm_points = (a[okay], b[okay])
        return (b-a)[okay]

    arm, outside = tracks(mask, keep_points=include_affine), tracks(255-mask)
    result = {'armTracks': len(arm), 'outsideTracks': len(outside),
              'trackingValid': len(arm) >= 5 and len(outside) >= 5,
              'backgroundDxPixels': None, 'backgroundDyPixels': None,
              'armResidualP90Pixels': None, 'armResidualP99Pixels': None,
              'armResidualMedianDxPixels': None, 'armResidualMedianDyPixels': None,
              'armMovingTracks': 0, 'armMovingMedianDxPixels': None, 'armMovingMedianDyPixels': None,
              'armMovingP10Pixels': None, 'armMovingP90Pixels': None,
              'armMovingDirectionCoherence': None,
              'armMovingFraction': None, 'outsideResidualP90Pixels': None}
    if not result['trackingValid']:
        if include_affine:
            result['fixedAnchorTracking'] = {'valid': False, 'estimator': 'fixed-anchor-affine-v1'}
        return result
    background = np.median(outside, axis=0)
    corrected = arm-background
    residual = np.linalg.norm(corrected, axis=1)
    median = np.median(corrected, axis=0)
    moving = corrected[residual > .15]
    result.update(backgroundDxPixels=float(background[0]), backgroundDyPixels=float(background[1]),
                  armResidualP90Pixels=float(np.percentile(residual, 90)),
                  armResidualP99Pixels=float(np.percentile(residual, 99)),
                  armResidualMedianDxPixels=float(median[0]), armResidualMedianDyPixels=float(median[1]),
                  armMovingTracks=len(moving),
                  armMovingFraction=float(np.mean(residual > .15)),
                  outsideResidualP90Pixels=float(np.percentile(np.linalg.norm(outside-background, axis=1), 90)))
    if include_affine:
        anchor = [(x+w/2)*width, (y+h/2)*height]
        result['fixedAnchorTracking'] = fit_fixed_anchor_affine(arm_points[0], arm_points[1], anchor, background)
        result['fixedAnchorTracking']['anchorPixels'] = anchor
    # Direction is descriptive image evidence, not a calibrated joint target.
    # Keep the all-track median above: selecting only movers can amplify noise.
    if len(moving) >= 5:
        moving_median = np.median(moving, axis=0)
        coherence = np.linalg.norm(np.mean(moving/np.linalg.norm(moving, axis=1)[:, None], axis=0))
        result.update(armMovingMedianDxPixels=float(moving_median[0]), armMovingMedianDyPixels=float(moving_median[1]),
                      armMovingP10Pixels=np.percentile(moving, 10, axis=0).tolist(),
                      armMovingP90Pixels=np.percentile(moving, 90, axis=0).tolist(),
                      armMovingDirectionCoherence=float(np.clip(coherence, 0, 1)))
    return result


def read_frame(previous_sequence=None, now=time.time):
    request = urllib.request.Request('http://127.0.0.1:8788/snapshot', headers={'Cache-Control': 'no-store'})
    with urllib.request.urlopen(request, timeout=2.5) as response:
        if response.headers.get_content_type() != 'image/jpeg':
            raise ValueError('Expected local JPEG camera frame')
        sequence = int(response.headers['x-frame-sequence'])
        received_at = response.headers['x-frame-received-at']
        age = now()-timestamp(received_at)
        if sequence <= 0 or not math.isfinite(age) or age < 0 or age > 1.0:
            raise ValueError('Camera frame is stale or has invalid timing')
        if previous_sequence is not None and sequence < previous_sequence:
            raise ValueError('Camera sequence restarted; inspect the view again')
        encoded = response.read(2*1024*1024+1)
    if len(encoded) > 2*1024*1024:
        raise ValueError('Camera frame exceeded bounded size')
    image = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None or image.size == 0:
        raise ValueError('Camera frame did not decode')
    image = cv2.resize(image, (640, 360), interpolation=cv2.INTER_AREA)
    image = cv2.GaussianBlur(image, (3, 3), .6)
    return image, {'sequence': sequence, 'frameReceivedAt': received_at, 'frameAgeMs': age*1000}


def run(seconds, tag):
    if not 1 <= seconds <= 180 or not re.fullmatch(r'[a-z0-9-]+', tag):
        raise ValueError('Expected 1–180 seconds and a simple tag')
    cv2.setNumThreads(1)
    started = time.monotonic()
    previous = None
    reference = None
    reference_metadata = None
    previous_sequence = None
    samples = []
    errors = []
    duplicates = 0
    last_unique = started
    print(json.dumps({'event': 'observing', 'seconds': seconds, 'cameraOnly': True, 'imagesSaved': False}), flush=True)
    while time.monotonic()-started < seconds:
        iteration = time.monotonic()
        try:
            image, metadata = read_frame(previous_sequence)
            if metadata['sequence'] == previous_sequence:
                duplicates += 1
                if time.monotonic()-last_unique > 1.0:
                    raise ValueError('Camera frame sequence stopped advancing')
            else:
                sampled_at = datetime.now(timezone.utc).isoformat()
                metrics = motion_metrics(previous, image) if previous is not None else None
                tracking = tracked_motion(previous, image) if previous is not None else None
                forearm_tracking = tracked_motion(previous, image, FOREARM_ROI) if previous is not None else None
                reference_tracking = tracked_motion(reference, image, FOREARM_ROI) if reference is not None else None
                sample = {**metadata, 'sampledAt': sampled_at, 'elapsedMs': (time.monotonic()-started)*1000,
                          'processingAndFetchMs': (time.monotonic()-iteration)*1000, 'metrics': metrics, 'tracking': tracking,
                          'forearmTracking': forearm_tracking, 'referenceTracking': reference_tracking,
                          'referenceSequence': reference_metadata['sequence'] if reference_metadata else None,
                          'referenceIntervalMs': (timestamp(metadata['frameReceivedAt'])-timestamp(reference_metadata['frameReceivedAt']))*1000 if reference_metadata else None}
                samples.append(sample)
                print(json.dumps({'event': 'frame', **sample}), flush=True)
                previous = image
                if reference is None:
                    reference = image
                    reference_metadata = metadata
                previous_sequence = metadata['sequence']
                last_unique = time.monotonic()
        except Exception as error:
            errors.append({'at': datetime.now(timezone.utc).isoformat(), 'error': str(error)})
            print(json.dumps({'event': 'observation-stopped', **errors[-1], 'movementIssued': False}), flush=True)
            break
        time.sleep(max(0, .2-(time.monotonic()-iteration)))
    previous = None
    reference = None
    report = {'createdAt': datetime.now(timezone.utc).isoformat(), 'durationSeconds': time.monotonic()-started,
              'requestedSeconds': seconds, 'imageRegion': ARM_ROI, 'forearmRegion': FOREARM_ROI, 'processingSize': [640, 360],
              'uniqueFrames': len(samples), 'duplicateFramesSkipped': duplicates, 'samples': samples, 'errors': errors,
              'imagesSaved': False, 'hardwareAccess': False, 'commandsSent': 0,
              'scope': 'Scalar image-change measurements from explicitly selected regions. No calibrated pose, object/obstacle detector, physical-stop proof or supervision inference. Current, previous and trial-reference grayscale frames held in memory only; no image bytes saved. Reference tracking can lose correspondence over long durations; track counts and background residuals must be inspected.'}
    output = ROOT/'runtime/perception-action-20261104'/f'{tag}.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'event': 'complete', 'output': str(output), 'uniqueFrames': len(samples), 'errors': errors, 'imagesSaved': False}), flush=True)
    return 1 if errors else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds', type=int, default=15)
    parser.add_argument('--tag', default='live-camera-observation')
    args = parser.parse_args()
    raise SystemExit(run(args.seconds, args.tag))
