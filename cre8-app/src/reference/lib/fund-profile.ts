import capture from "../data/fund-explore/profiles.json" with {type:"json"};

export type FundProfile = {name:string;role:string;bio:string;sources:string[]};
export const fundProfile=(slug:string):FundProfile|null=>(capture.profiles as Record<string,FundProfile>)[slug]??null;
const esc=(value:string)=>value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;");
export function fundProfileMarkup(profile:FundProfile,image:string) {
  return `<button type="button" class="fund-profile-close" aria-label="Close introduction">×</button><header>${image?`<img src="${esc(image)}" alt="" width="48" height="48">`:""}<span><strong>${esc(profile.name)}</strong><small>${esc(profile.role)}</small></span></header><p>${esc(profile.bio)}</p>`;
}

/** One introduction shared by avatar taps, name hovers and keyboard focus. Links still navigate. */
export function attachFundProfiles(root:HTMLElement,card:HTMLElement,lookup:(slug:string)=>{profile:FundProfile;image:string}|null) {
  const events=new AbortController(),signal=events.signal;
  let trigger:HTMLElement|null=null,opened=false,pinned=false,restoring=false,timer:ReturnType<typeof setTimeout>|null=null;
  const cancel=()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
  function position(){
    if(!trigger||!opened)return;
    const margin=12,width=document.documentElement.clientWidth||window.innerWidth,rect=trigger.getBoundingClientRect();
    card.style.maxWidth=`${Math.max(0,width-2*margin)}px`;
    card.style.left=`${Math.max(margin,Math.min(rect.left,width-card.offsetWidth-margin))}px`;
    card.style.top=`${Math.max(margin,Math.min(rect.bottom+8+card.offsetHeight<=window.innerHeight-margin?rect.bottom+8:rect.top-card.offsetHeight-8,window.innerHeight-card.offsetHeight-margin))}px`;
  }
  function close(restore=false){
    cancel();if(!opened)return;opened=false;pinned=false;
    trigger?.removeAttribute("aria-describedby");trigger?.setAttribute("aria-expanded","false");
    if(card.hidePopover&&card.isConnected)card.hidePopover();card.removeAttribute("data-open");
    if(restore&&trigger?.isConnected){restoring=true;trigger.focus({preventScroll:true});restoring=false;}trigger=null;
  }
  function show(element:HTMLElement){
    cancel();if(!card.isConnected)return;const data=lookup(element.dataset.fundProfile??"");if(!data)return;
    if(trigger!==element){trigger?.removeAttribute("aria-describedby");trigger?.setAttribute("aria-expanded","false");pinned=false;trigger=element;card.innerHTML=fundProfileMarkup(data.profile,data.image);card.setAttribute("aria-label",`About ${data.profile.name}`);}
    element.setAttribute("aria-describedby",card.id);element.setAttribute("aria-expanded","true");
    if(!opened){if(card.showPopover)card.showPopover();else card.setAttribute("data-open","");opened=true;}position();
  }
  const target=(event:Event)=>(event.target as Element)?.closest?.<HTMLElement>("[data-fund-profile]")??null;
  const later=()=>{cancel();if(!pinned)timer=setTimeout(()=>close(),180);};
  root.addEventListener("pointerover",event=>{const el=target(event);if(el&&event.pointerType==="mouse")show(el);},{signal});
  root.addEventListener("pointerout",event=>{const el=target(event),to=event.relatedTarget as Node|null;if(el&&!el.contains(to)&&!card.contains(to))later();},{signal});
  root.addEventListener("focusin",event=>{const el=target(event);if(el&&!restoring)show(el);},{signal});
  root.addEventListener("focusout",event=>{const to=event.relatedTarget as Node|null;if(!card.contains(to)&&!trigger?.contains(to))later();},{signal});
  root.addEventListener("click",event=>{const el=target(event);if(!el)return;if(el.tagName==="A"){close();return;}if(trigger===el&&opened&&pinned){close();return;}show(el);pinned=true;},{signal});
  card.addEventListener("pointerenter",cancel,{signal});card.addEventListener("pointerleave",later,{signal});
  card.addEventListener("focusout",event=>{const to=event.relatedTarget as Node|null;if(!card.contains(to)&&!trigger?.contains(to))close();},{signal});
  card.addEventListener("click",event=>{if((event.target as Element)?.closest(".fund-profile-close"))close(true);},{signal});
  document.addEventListener("pointerdown",event=>{if(!root.isConnected||!card.isConnected){close();events.abort();return;}if(!card.contains(event.target as Node)&&!trigger?.contains(event.target as Node))close();},{signal});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&opened){event.preventDefault();close(card.contains(document.activeElement));}},{signal});
  window.addEventListener("resize",position,{signal});window.addEventListener("scroll",()=>{if(!trigger)return;const rect=trigger.getBoundingClientRect();if(!trigger.isConnected||rect.bottom<0||rect.top>window.innerHeight)close();else position();},{signal,passive:true,capture:true});
  return {abort:()=>{close();events.abort();}};
}
