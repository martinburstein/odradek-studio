import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { evaluateNativeMetadata, inspectNativeExecutable, normalizeVersion } from '../scripts/verify-learning-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pe = require('pe-library');
const resedit = require('resedit');

test('PE resource reader extracts version strings and embedded icon groups without launching the executable', async () => {
  const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const referenceIcon = await fs.readFile(path.join(root, 'assets', 'app', 'odradek.ico'));
  const inspected = inspectNativeExecutable(await fs.readFile(electronExe), referenceIcon);
  assert.ok(inspected.versions.length > 0);
  assert.ok(inspected.versions.some(block => block.strings.some(table => table.values.ProductName === 'Electron')));
  assert.ok(inspected.icons.reference.length >= 4);
  assert.ok(inspected.icons.groups.some(group => group.icons.some(icon => icon.width >= 16 && icon.height >= 16)));
  assert.equal(normalizeVersion('0.5.0.0'), '0.5.0');
});

test('metadata evaluator accepts canonical app name and Windows four-part version fields', () => {
  const inspected = {
    versions: [{
      fixed: { fileVersion: '0.5.0.0', productVersion: '0.5.0.0' },
      strings: [{ values: {
        FileDescription: 'Odradek Lab',
        ProductName: 'Odradek Lab',
        OriginalFilename: '',
        FileVersion: '0.5.0.0',
        ProductVersion: '0.5.0.0',
      } }],
    }],
    icons: { reference: [{ width: 16, height: 16 }, { width: 32, height: 32 }, { width: 48, height: 48 }, { width: 256, height: 256 }], groups: [{
      id: 1,
      icons: [16, 32, 48, 256].map(size => ({ width: size, height: size, sourceMatch: true })),
    }] },
  };
  const result = evaluateNativeMetadata(inspected, { productName: 'OdradekLab', version: '0.5.0' });
  assert.deepEqual(result.metadata, { fileDescription: true, productName: true, originalFilename: true, noElectronIdentity: true, fileVersion: true, productVersion: true });
  assert.equal(result.icon, true);
  assert.equal(result.ok, true);
});

test('metadata evaluator flags legacy Electron filename, wrong version, or embedded icon content', () => {
  const inspected = {
    versions: [{ fixed: { fileVersion: '0.5.1.0', productVersion: '0.5.1.0' }, strings: [{ values: {
      FileDescription: 'Odradek Lab', ProductName: 'Odradek Lab', InternalName: 'electron.exe', OriginalFilename: 'electron.exe', FileVersion: '0.5.1.0', ProductVersion: '0.5.1.0',
    } }] }],
    icons: { reference: [], groups: [{ id: 1, icons: [{ width: 16, height: 16, sourceMatch: false }] }] },
  };
  const result = evaluateNativeMetadata(inspected, { productName: 'Odradek Lab', version: '0.5.0' });
  assert.equal(result.metadata.fileDescription, true);
  assert.equal(result.metadata.originalFilename, false);
  assert.equal(result.metadata.noElectronIdentity, false);
  assert.equal(result.metadata.fileVersion, false);
  assert.equal(result.metadata.productVersion, false);
  assert.equal(result.icon, false);
  assert.equal(result.ok, false);
});

test('PE reader matches edited in-memory metadata and icon image bytes to the committed ICO', async () => {
  const base = pe.NtExecutable.from(await fs.readFile(path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')), { ignoreCert: true });
  const resources = pe.NtExecutableResource.from(base);
  const version = resedit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  const iconBytes = await fs.readFile(path.join(root, 'assets', 'app', 'odradek.ico'));
  const iconFile = resedit.Data.IconFile.from(iconBytes);
  version.setFileVersion(0, 5, 0, 0, 1033);
  version.setProductVersion(0, 5, 0, 0, 1033);
  version.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Odradek Lab',
    ProductName: 'Odradek Lab',
    InternalName: 'Odradek Lab',
    OriginalFilename: '',
  });
  version.outputToResourceEntries(resources.entries);
  resedit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, iconFile.icons.map(item => item.data));
  resources.outputResource(base);

  const inspected = inspectNativeExecutable(Buffer.from(base.generate()), iconBytes);
  const result = evaluateNativeMetadata(inspected, { productName: 'Odradek Lab', version: '0.5.0' });
  assert.equal(result.ok, true);
  assert.equal(result.icon, true);
  assert.deepEqual(result.iconEvidence.matchedGroupId, 1);
  assert.ok(result.iconEvidence.groups[0].icons.every(icon => icon.sourceMatch));
});
