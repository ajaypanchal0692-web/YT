import os,json,re,subprocess,pathlib,requests,asyncio,edge_tts
from PIL import Image,ImageDraw,ImageFont

OUT=pathlib.Path("output");OUT.mkdir(exist_ok=True)
API=os.environ["WORKER_API_URL"].rstrip("/");TOKEN=os.environ["APP_TOKEN"];JOB=os.environ["JOB_ID"]
TOPIC=os.environ["TOPIC"];LANG=os.getenv("LANGUAGE","en");FMT=os.getenv("FORMAT","short");MINS=max(1,min(8,int(os.getenv("MINUTES","1"))))
HEAD={"Authorization":"Bearer "+TOKEN}
VOICES={"en":"en-IN-NeerjaNeural","hi":"hi-IN-SwaraNeural","mr":"mr-IN-AarohiNeural"}
LANGS={"en":"English","hi":"Hindi","mr":"Marathi"}
def run(cmd):subprocess.run(cmd,check=True)
def generate():
    key=os.getenv("GEMINI_API_KEY","")
    if not key: raise RuntimeError("GEMINI_API_KEY is missing. Add a free-tier Gemini API key in GitHub repository secrets; no paid key is required.")
    url="https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key="+key
    prompt=f"""Create an original YouTube video package in {LANGS[LANG]} about {TOPIC}.
Target length {MINS} minutes. Format {FMT}. Return ONLY JSON with keys title,description,narration,tags,scenes.
Narration must sound natural when spoken in {LANGS[LANG]}, not a literal translation. Avoid unsupported claims,
invented statistics, plagiarism, copyrighted characters, celebrity likenesses, logos and lyrics.
Provide exactly 6 scenes. Each scene has visual_prompt (detailed English cinematic photorealistic film-still prompt,
no text, no logo) and caption (short in {LANGS[LANG]}). Title and description must be in {LANGS[LANG]}.
Tags must be a short array of relevant terms."""
    r=requests.post(url,json={"contents":[{"parts":[{"text":prompt}]}],"generationConfig":{"responseMimeType":"application/json","temperature":0.65}},timeout=120)
    r.raise_for_status()
    return json.loads(r.json()["candidates"][0]["content"]["parts"][0]["text"])
def fallback():
    samples={"en":f"Today we explore {TOPIC}. We will understand the main ideas, why they matter, and practical points to remember.",
    "hi":f"आज हम {TOPIC} के बारे में जानेंगे। इसके मुख्य पहलुओं को समझेंगे और जानेंगे कि यह विषय क्यों महत्वपूर्ण है।",
    "mr":f"आज आपण {TOPIC} या विषयाबद्दल जाणून घेणार आहोत. त्यातील महत्त्वाचे मुद्दे आणि त्यांचे महत्त्व समजून घेऊया."}
    narration=(samples[LANG]+" ")*max(5,MINS*10)
    return {"title":TOPIC[:90],"description":f"{LANGS[LANG]} video about {TOPIC}. Please verify all factual claims before publishing.",
    "narration":narration,"tags":[TOPIC],"scenes":[{"visual_prompt":f"Cinematic establishing shot about {TOPIC}, photorealistic documentary film still, no text or logos","caption":TOPIC},
    {"visual_prompt":f"Photorealistic cinematic close-up illustrating {TOPIC}, dramatic natural light, no text","caption":TOPIC},
    {"visual_prompt":f"Wide documentary scene related to {TOPIC}, detailed realistic environment, no text","caption":TOPIC},
    {"visual_prompt":f"Human-scale practical scene showing {TOPIC}, cinematic film still, no text","caption":TOPIC},
    {"visual_prompt":f"Atmospheric cinematic image representing {TOPIC}, rich visual detail, no text","caption":TOPIC},
    {"visual_prompt":f"Hopeful cinematic closing image related to {TOPIC}, photorealistic, no text","caption":TOPIC}]}

try:
    data=generate() or fallback()
    narration=re.sub(r"\s+"," ",str(data["narration"])).strip()
    (OUT/"script.json").write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding="utf-8")
    (OUT/"narration.txt").write_text(narration,encoding="utf-8")
    # Neural TTS runs on the hosted cloud runner; no local PC processing or paid API key.
    async def tts():
        await edge_tts.Communicate(narration,VOICES[LANG],rate="+0%").save(str(OUT/"voice.mp3"))
    asyncio.run(tts())

    # Generate six AI images with Cloudflare Workers AI FLUX and retain them in private R2.
    imgs=[]
    for i,scene in enumerate(data["scenes"][:6],1):
        r=requests.post(f"{API}/api/jobs/{JOB}/scene",headers={**HEAD,"Content-Type":"application/json"},
          json={"index":i,"prompt":scene["visual_prompt"]},timeout=180);r.raise_for_status()
        a=requests.get(r.json()["url"],timeout=90);a.raise_for_status()
        path=OUT/f"scene-{i:02d}.jpg";path.write_bytes(a.content);imgs.append(path)

    duration=float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",str(OUT/"voice.mp3")],text=True).strip())
    width,height=(1080,1920) if FMT=="short" else (1920,1080)
    segment=duration/len(imgs);parts=[]
    for i,img in enumerate(imgs):
        out=OUT/f"scene-{i:02d}.mp4";frames=max(1,int(segment*25))
        vf=f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},zoompan=z='min(zoom+0.00065,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={width}x{height}:fps=25,fade=t=in:st=0:d=0.35,fade=t=out:st={max(0,segment-0.35):.3f}:d=0.35,setsar=1,format=yuv420p"
        run(["ffmpeg","-y","-loop","1","-framerate","25","-i",str(img),"-t",str(segment),"-vf",vf,"-an","-c:v","libx264","-preset","veryfast","-crf","27","-maxrate","2M","-bufsize","4M",str(out)])
        parts.append(out)
    (OUT/"concat.txt").write_text("".join(f"file '{x.resolve()}'\n" for x in parts),encoding="utf-8")
    run(["ffmpeg","-y","-f","concat","-safe","0","-i",str(OUT/"concat.txt"),"-i",str(OUT/"voice.mp3"),"-shortest","-c:v","copy","-c:a","aac","-b:a","128k",str(OUT/"base.mp4")])

    # Approximate word-weighted subtitle timings. Human review is required for final timing/translation.
    sentences=[x.strip() for x in re.split(r"(?<=[.!?।])\s+",narration) if x.strip()]
    weights=[max(1,len(x.split())) for x in sentences];totalw=sum(weights);cursor=0;srt=[]
    def stamp(v):
        ms=int(v*1000);h=ms//3600000;ms%=3600000;m=ms//60000;ms%=60000;s=ms//1000;ms%=1000
        return f"{h:02}:{m:02}:{s:02},{ms:03}"
    for sentence,weight in zip(sentences,weights):
        d=duration*weight/totalw;srt.append(f"{len(srt)+1}\n{stamp(cursor)} --> {stamp(min(duration,cursor+d))}\n{sentence}\n");cursor+=d
    (OUT/"captions.srt").write_text("\n".join(srt),encoding="utf-8")
    final=OUT/"final.mp4"
    run(["ffmpeg","-y","-i",str(OUT/"base.mp4"),"-vf",f"subtitles={OUT/'captions.srt'}:force_style='FontName=Noto Sans Devanagari,FontSize=22,Outline=2,Shadow=1,Alignment=2,MarginV=65'","-c:v","libx264","-preset","veryfast","-crf","27","-maxrate","2M","-bufsize","4M","-c:a","copy","-movflags","+faststart",str(final)])

    # Create a simple localized thumbnail using Noto fonts.
    thumb=Image.open(imgs[0]).convert("RGB").resize((1280,720));draw=ImageDraw.Draw(thumb)
    fontfile="/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf" if LANG in ("hi","mr") else "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    if not pathlib.Path(fontfile).exists():fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    font=ImageFont.truetype(fontfile,54);draw.rectangle((0,505,1280,720),fill=(5,15,28))
    title=str(data.get("title",TOPIC))[:60];draw.text((48,545),title,font=font,fill="white",stroke_width=2,stroke_fill="black")
    thumb.save(OUT/"thumbnail.jpg",quality=90)

    meta={"title":title,"description":data.get("description",""),"tags":data.get("tags",[])[:15]}
    (OUT/"metadata.json").write_text(json.dumps(meta,ensure_ascii=False),encoding="utf-8")
    requests.post(f"{API}/api/jobs/{JOB}/metadata",headers={**HEAD,"Content-Type":"application/json"},
      json={"title":meta["title"],"description":meta["description"],"script":narration,"tags":meta["tags"]},timeout=60).raise_for_status()
    with open(final,"rb") as f:requests.put(f"{API}/api/jobs/{JOB}/media",headers={**HEAD,"Content-Type":"video/mp4"},data=f,timeout=300).raise_for_status()
    with open(OUT/"thumbnail.jpg","rb") as f:requests.put(f"{API}/api/jobs/{JOB}/thumbnail",headers={**HEAD,"Content-Type":"image/jpeg"},data=f,timeout=120).raise_for_status()
    print("Video is ready in R2 for human review.")
except Exception as exc:
    try:requests.post(f"{API}/api/jobs/{JOB}/failed",headers={**HEAD,"Content-Type":"application/json"},json={"error":str(exc)[:900]},timeout=30)
    except Exception:pass
    raise
