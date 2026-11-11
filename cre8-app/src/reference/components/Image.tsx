import type { ImgHTMLAttributes } from 'react';
// 正式 UI 素材已是靜態可用格式；Vite 不需要 Next 的影像轉換服務。
export default function Image({unoptimized,priority,fill,...props}:ImgHTMLAttributes<HTMLImageElement>&{unoptimized?:boolean;priority?:boolean;fill?:boolean}) {
  void unoptimized;return <img {...props} style={fill?{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",...props.style}:props.style} fetchPriority={priority?'high':props.fetchPriority}/>;
}
