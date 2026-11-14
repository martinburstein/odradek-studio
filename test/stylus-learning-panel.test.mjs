import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [markup,css]=await Promise.all([
 readFile(new URL('../src/replica/learning/panel.js',import.meta.url),'utf8'),
 readFile(new URL('../src/replica/learning/panel.css',import.meta.url),'utf8'),
]);

test('metric cards style the wrappers actually rendered inside the definition list',()=>{
 assert.ok(/<dl class="learning-metrics"><div>/.test(markup),'expected direct div wrappers around each dt/dd pair');
 assert.ok(/\.learning-metrics\s*>\s*div\s*\{/.test(css),'CSS needs a card rule for the rendered div wrappers');
});

test('HUD state values receive matching pass, warn, and fail styling',()=>{
 assert.ok(/hud\.dataset\.state\s*=/.test(markup),'frame renderer assigns a semantic HUD state');
 for(const state of ['pass','warn','fail'])assert.ok(new RegExp(`\\.learning-hud\\[data-state=${state}\\]`).test(css),`HUD needs matching ${state} styling`);
});

test('legend color markers in CSS are present in the rendered legend markup',()=>{
 assert.ok(/class="learning-legend"[^`]*data-kind=/s.test(markup),'legend entries need semantic kind markers');
 assert.ok(/\.learning-legend\s+\[data-kind=/.test(css),'legend marker styles must target rendered entries');
});
