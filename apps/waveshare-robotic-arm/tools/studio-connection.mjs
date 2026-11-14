// Startup connects the identified arm for feedback only. No ownership or motion.
export async function prepareStudioConnection({api,listPorts}){
 const state=await api('status');
 if(state.connected)return {connected:true,mode:state.mode,reused:true};
 if(state.armed||state.owner||state.movement?.active||state.movement?.session||state.execution?.busy||state.execution?.lifecycle||state.execution?.cleanupPending||state.execution?.recoveryRequired||state.execution?.outstandingTransportOperations)throw Error('Controller operation must finish before startup can connect');
 const ports=(await listPorts()).filter(p=>p.serialNumber==='508E797BEB72EF1197387E4F8FCC3FA0'&&p.vendorId?.toLowerCase()==='10c4'&&p.productId?.toLowerCase()==='ea60');
 if(ports.length!==1)return {connected:false,reason:ports.length?'Arm USB identity is ambiguous':'Waiting for the arm USB connection'};
 const result=await api('connect',{mode:'serial',port:ports[0].path});
 if(!result.connected||result.mode!=='serial'||result.armed)throw Error('Idle serial connection was not established');
 return {connected:true,mode:'serial',port:ports[0].path,reused:false};
}
