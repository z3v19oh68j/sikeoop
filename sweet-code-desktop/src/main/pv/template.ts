import type { PvProject, PvStoryboard } from "../../shared/types.ts";
export function remotionTemplate(p:PvProject,sb:PvStoryboard):Record<string,string>{
  const [width,height]=p.ratio==="9:16"?[1080,1920]:p.ratio==="1:1"?[1080,1080]:[1920,1080];
  return {
    "package.json":JSON.stringify({private:true,scripts:{render:"remotion render src/index.tsx PV ../out/preview.mp4"},dependencies:{"@remotion/cli":"4.0.409",remotion:"4.0.409",react:"19.0.0","react-dom":"19.0.0"}},null,2),
    "src/storyboard.json":JSON.stringify(sb,null,2),
    "src/index.tsx":`import React from 'react';
import {registerRoot,Composition,AbsoluteFill,Sequence,useCurrentFrame,interpolate} from 'remotion';
import storyboard from './storyboard.json';
const Shot=({shot})=>{const frame=useCurrentFrame();return <AbsoluteFill style={{background:'#101322',color:'white',justifyContent:'center',alignItems:'center',fontFamily:'sans-serif',padding:90}}><div style={{fontSize:76,opacity:interpolate(frame,[0,15],[0,1],{extrapolateRight:'clamp'}),transform:'translateY('+interpolate(frame,[0,20],[35,0],{extrapolateRight:'clamp'})+'px)'}}>{shot.caption||shot.visual}</div></AbsoluteFill>};
const Film=()=>{let at=0;return <AbsoluteFill>{storyboard.shots.map(shot=>{const n=Math.max(1,Math.round(shot.seconds*30));const from=at;at+=n;return <Sequence key={shot.id} from={from} durationInFrames={n}><Shot shot={shot}/></Sequence>})}</AbsoluteFill>};
registerRoot(()=> <Composition id="PV" component={Film} width={${width}} height={${height}} fps={30} durationInFrames={${Math.max(1,sb.shots.reduce((n,s)=>n+Math.round(s.seconds*30),0))}}/>);
`,
    "README.md":"# PV 合成工程\n依赖仅写入本项目。请自行在此目录安装依赖；应用不会自动联网安装。\n执行 npm run render。Remotion 使用许可请由使用者按团队规模核对。\n"
  };
}
