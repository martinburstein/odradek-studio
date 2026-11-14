import {validPose} from '../../../apps/bot-crossing/src/arm-manual/model.js';
import {validateDesk} from '../state.js';

// Select a caller-owned Manual context or an explicitly saved draft, then
// detach the replay setup from either source object.
export function learningSetup(pose,desk,draft=null){
 const selectedPose=draft===null?pose:draft?.pose;
 const selectedDesk=draft===null?desk:draft?.desk;
 if(!validPose(selectedPose))throw Error('Learning Lab needs a valid saved Manual pose.');
 return{pose:{...selectedPose},desk:validateDesk(selectedDesk)};
}
