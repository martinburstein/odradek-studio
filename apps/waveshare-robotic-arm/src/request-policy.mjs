export function validatePrivateOrigin(value) {
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string')throw Error('Private origin must be a string');
 const parsed=new URL(value);
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||parsed.pathname!=='/'||parsed.search||parsed.hash||!parsed.hostname.endsWith('.ts.net')||!/^[-a-z0-9.]+$/.test(parsed.hostname))throw Error('Configure the exact private HTTPS Tailscale origin without a path or port');
 return parsed.origin;
}

export function classifyRequest(req,{localUrl,privateOrigin=null}) {
 privateOrigin=validatePrivateOrigin(privateOrigin);
 const local=new URL(localUrl);
 const host=req.headers.host;
 const directHost=[local.host,`localhost:${local.port}`].includes(host);
 const proxyHeaders=Object.keys(req.headers).some(key=>key==='forwarded'||key.startsWith('x-forwarded-')||key.startsWith('tailscale-'));
 const address=req.socket?.remoteAddress;
 const loopback=address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
 const direct=directHost&&!proxyHeaders&&loopback;
 const remote=Boolean(privateOrigin&&host===new URL(privateOrigin).host);
 if(!direct&&!remote)throw Error('Unknown host or proxy; configure the exact private origin');
 if(remote&&req.headers['x-forwarded-proto']&&req.headers['x-forwarded-proto']!=='https')throw Error('Private proxy must provide HTTPS');
 const forwardedProtocol=/(?:^|[;,])\s*proto="?([^;,"\s]+)/i.exec(req.headers.forwarded??'')?.[1];
 if(remote&&forwardedProtocol&&forwardedProtocol.toLowerCase()!=='https')throw Error('Private proxy must provide HTTPS');
 const expectedOrigin=direct?`http://${host}`:privateOrigin;
 if(req.headers.origin&&req.headers.origin!==expectedOrigin)throw Error('Cross-origin request rejected');
 // Host and Origin alone do not grant credentials. Remote requests still need
 // a paired device session; an administrator credential is local only.
 return {local:direct,proxied:!direct,secure:!direct,origin:expectedOrigin};
}

export function permitSession(session,classification) {
 if(!session)return null;
 if(!['admin','observer','control'].includes(session.role))return null;
 if(session.role==='admin'&&!classification.local)return null;
 return session;
}
