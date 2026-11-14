// Retrospective analysis only. This module cannot send or schedule commands.
export const ENCODER_TICK_RAD = 2 * Math.PI / 4096;
const degrees = rad => rad * 180 / Math.PI;
export function analyzeElbowTrace(trial) {
  const samples = trial.observations;
  if (!Array.isArray(samples) || samples.length < 3) throw Error('At least three timestamped samples required');
  if (![trial.start?.elbow, trial.target?.elbow].every(Number.isFinite)) throw Error('Start and target required');
  let previous = -Infinity;
  for (const sample of samples) {
    const time = Date.parse(sample.observedAt);
    if (!Number.isFinite(time) || time <= previous || !Number.isFinite(sample.joints?.elbow)) throw Error('Invalid or nonmonotonic trace');
    previous = time;
  }
  const firstAt = Date.parse(samples[0].observedAt), lastAt = Date.parse(samples.at(-1).observedAt);
  const final = samples.at(-1).joints.elbow;
  // Retrospective settling: earliest sample after which every recorded sample
  // remains within one encoder tick of the FINAL OBSERVED value. This is not
  // target arrival, not a live stopping rule, and not dispatch-relative timing.
  const tolerance = ENCODER_TICK_RAD + 1e-9;
  let settledIndex = samples.length - 1;
  while (settledIndex > 0 && Math.abs(samples[settledIndex - 1].joints.elbow - final) <= tolerance) settledIndex--;
  const settledAt = Date.parse(samples[settledIndex].observedAt);
  const dwellMs = lastAt - settledAt;
  const settlingSupported = dwellMs >= 1000 && samples.length - settledIndex >= 5;
  const endWindow = samples.filter(s => lastAt - Date.parse(s.observedAt) <= 1000).map(s => s.joints.elbow);
  const voltages = samples.map(s => s.health?.v).filter(Number.isFinite);
  return {
    sampleCount: samples.length, firstFeedbackAt: samples[0].observedAt,
    lastFeedbackAt: samples.at(-1).observedAt, observedSpanMs: lastAt - firstAt,
    requestedDegrees: degrees(trial.target.elbow - trial.start.elbow),
    observedDegrees: degrees(final - trial.start.elbow),
    signedEndpointErrorDegrees: degrees(final - trial.target.elbow),
    finalEncoderRadians: final,
    finalSecondRangeDegrees: degrees(Math.max(...endWindow) - Math.min(...endWindow)),
    retrospectiveSettling: {supported: settlingSupported, toleranceTicks: 1,
      millisecondsAfterFirstFeedback: settlingSupported ? settledAt - firstAt : null,
      observedDwellMs: dwellMs, samples: samples.length - settledIndex,
      reference: 'final observed encoder value; NOT requested target'},
    voltageRawRange: voltages.length ? [Math.min(...voltages), Math.max(...voltages)] : null,
    repeatabilityDegrees: null, directionHysteresisDegrees: null,
    physicalAccuracyDegrees: null,
    limitations: ['No external angle metrology', 'Dispatch timestamp unavailable in legacy receipt',
      'One trial at this target; repeatability cannot be estimated',
      'No reverse-direction matched pair; hysteresis cannot be estimated']
  };
}
