import fs from 'node:fs/promises';
import path from 'node:path';
import {isOtherExperiment,otherExperimentPolicy} from './other-joint-plan.mjs';
import {TRAINING_ENVELOPE_REVISION} from './training-envelope.mjs';
// Deployment policy, written locally by the lead after the operator's boundary
// confirmation. No public API creates, removes or relaxes it.
export async function assertOperatingEnvelope(directory,experiment){
 // Installing the shared configuration retires every legacy physical dispatch path.
 // Even a disabled/corrupt configuration cannot silently fall back to old authority.
 try{await fs.stat(path.join(directory,'commissioning','motion.json'));throw Error('Use the shared movement controller; legacy physical paths are retired');}catch(e){if(e.code!=='ENOENT')throw e;}
 let policy;
 try{policy=JSON.parse(await fs.readFile(path.join(directory,'commissioning','operating-envelope.json'),'utf8'));}
 catch(e){if(e.code==='ENOENT'&&experiment!=='supervised-elbow-characterization-v1'&&!isOtherExperiment(experiment))return;throw Error('Active operating-envelope policy is missing or unreadable');}
 if(policy.kind!=='supervised-elbow-only'||policy.revision!==TRAINING_ENVELOPE_REVISION||policy.floor!=='shoulder-pivot-center'||policy.existingShoulderAttachmentAllowed!==true||policy.shoulderHeld!==true)throw Error('Unsupported operating-envelope policy');
 if(isOtherExperiment(experiment)&&policy.additionalEnvelopeRevision===otherExperimentPolicy(experiment).envelopeRevision&&Array.isArray(policy.additionalExperiments)&&policy.additionalExperiments.includes(experiment))return;
 if(experiment!=='supervised-elbow-characterization-v1')throw Error('Active whole-body floor policy permits only the reviewed elbow training path');
}
