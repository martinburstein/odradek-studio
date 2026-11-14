function createServiceRestart({supervisor,workspace,load,prepareRestart=async()=>{},canRestart=()=>true,routeForMode=mode=>'5291/arm-manual/?workspace='+encodeURIComponent(mode)}){
 let running=false;
 return async function restartServices(){
  if(running)throw Error('A clean service restart is already running.');
  const mode=workspace.mode;running=true;
  try{
   await supervisor.stop();
   await prepareRestart();
   if(!canRestart())throw Error('The app is closing; local services were left stopped.');
   await supervisor.start();
   workspace.reload();
   await load(routeForMode(mode));
  }finally{running=false;}
 };
}
module.exports={createServiceRestart};
