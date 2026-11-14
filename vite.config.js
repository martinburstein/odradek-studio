import {defineConfig} from 'vite';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {createViewerSourceManifestPlugin} from './scripts/viewer-source-manifest.mjs';
const version=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
export default defineConfig({
 plugins:[createViewerSourceManifestPlugin()],
 resolve:{alias:[{find:'/src/arm-manual/main.js',replacement:path.resolve('src/replica/main.js')}]},
 define:{__ODRADEK_VERSION__:JSON.stringify(version)},
 root:'apps/bot-crossing',publicDir:false,
 build:{outDir:path.resolve('dist'),emptyOutDir:true,target:'esnext',rollupOptions:{input:path.resolve('apps/bot-crossing/arm-manual/index.html')}}
});
