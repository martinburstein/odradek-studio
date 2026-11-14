import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const packageConfig=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const installer=await readFile(new URL('../desktop/installer.nsh',import.meta.url),'utf8');

test('installer blocks a running app without killing it and reports silent refusal',()=>{
 assert.equal(packageConfig.build.nsis.include,'desktop/installer.nsh');
 assert.match(installer,/!macro customCheckAppRunning[\s\S]*Get-Process -Name 'Odradek Studio'[\s\S]*SetErrorLevel 2[\s\S]*Quit[\s\S]*!macroend/);
 assert.doesNotMatch(installer,/taskkill|Stop-Process|Kill\(/i);
});

test('installer shortcuts stay under Apps and Learning Lab uses the offline flag',()=>{
 assert.equal(packageConfig.build.nsis.createDesktopShortcut,false);
 assert.match(installer,/CreateDirectory "\$DESKTOP\\Apps"/);
 assert.match(installer,/CreateShortCut "\$DESKTOP\\Apps\\Odradek Studio\.lnk"/);
 assert.match(installer,/CreateShortCut "\$DESKTOP\\Apps\\Odradek Studio Learning Lab\.lnk"[^\r\n]*"--learning"/);
 assert.match(installer,/CreateShortCut "\$SMPROGRAMS\\Odradek Studio Learning Lab\.lnk"[^\r\n]*"--learning"/);
});
