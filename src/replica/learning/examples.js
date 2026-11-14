import cornerAfterText from '../../../assets/learning/stylus-corner-after-v2.json?raw';
import cornerBeforeText from '../../../assets/learning/stylus-corner-before-v1.json?raw';
import firstRunText from '../../../assets/learning/stylus-example-v1.json?raw';
import mountExplorationText from '../../../assets/learning/stylus-mount4-exploration-v2.json?raw';

export const bundledExamples=Object.freeze([
 {id:'corner-after',label:'Revised corner practice',isDefault:true,text:cornerAfterText,note:'Paired seed 20261115, population 48, 800 generations. Across inspected development test paths, maximum penetration fell from 2.243 mm to 0.296 mm, while mean contact RMS rose from 0.216 mm to 0.525 mm. These are simulation results, not physical validation or an untouched holdout.'},
 {id:'corner-before',label:'Earlier corner practice',isDefault:false,text:cornerBeforeText,note:'Earlier paired seed 20261115 run. The inspected development corner poke dug 2.243 mm at 0.20 s during approach, then later achieved contact. This is a retained adverse simulation result, not physical evidence or an untouched holdout.'},
 {id:'first-run',label:'First learning run',isDefault:false,text:firstRunText,note:'Original generation-800 exploratory run with best-policy snapshots only. It predates the paired corner study and does not have winner or worst-candidate snapshots.'},
 {id:'mount-exploration',label:'Fixed-mount exploration',isDefault:false,text:mountExplorationText,note:'Hypothetical fixed +4° mount. An alternative fixed tool mounting angle for comparison in the simulator; errors still vary. This is not a physical setup recommendation.'},
]);
export const defaultExample=bundledExamples.find(example=>example.isDefault);
