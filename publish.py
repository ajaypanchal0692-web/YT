import os,requests,pathlib,tempfile
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
api=os.environ["WORKER_API_URL"].rstrip("/");token=os.environ["PUBLISHER_TOKEN"];job=os.environ["JOB_ID"]
headers={"Authorization":"Bearer "+token}
r=requests.get(f"{api}/api/publish/{job}",headers=headers,timeout=60);r.raise_for_status();data=r.json()
video=requests.get(data["media_url"],timeout=180);video.raise_for_status()
with tempfile.TemporaryDirectory() as td:
    mp4=pathlib.Path(td)/"video.mp4";mp4.write_bytes(video.content)
    yt=build("youtube","v3",credentials=Credentials(token=data["access_token"]))
    body={"snippet":{"title":data["title"][:100],"description":data["description"][:5000],"categoryId":"22","defaultLanguage":data["language"],"tags":data.get("tags",[])[:15]},
          "status":{"privacyStatus":"private"}}
    req=yt.videos().insert(part="snippet,status",body=body,media_body=MediaFileUpload(str(mp4),mimetype="video/mp4",resumable=True,chunksize=8*1024*1024))
    response=None
    while response is None:
        progress,response=req.next_chunk()
        if progress:print(f"Upload progress {int(progress.progress()*100)}%")
    vid=response["id"]
    # Commit the private-upload state before optional thumbnail work, preventing duplicate uploads on thumbnail errors.
    done=requests.post(f"{api}/api/publish/{job}/done",headers={**headers,"Content-Type":"application/json"},json={"video_id":vid},timeout=60)
    done.raise_for_status()
    if data.get("thumbnail_url"):
        try:
            tr=requests.get(data["thumbnail_url"],timeout=60);tr.raise_for_status()
            jpg=pathlib.Path(td)/"thumb.jpg";jpg.write_bytes(tr.content)
            yt.thumbnails().set(videoId=vid,media_body=MediaFileUpload(str(jpg),mimetype="image/jpeg")).execute()
        except Exception as ex:
            print("Private video uploaded; thumbnail update needs manual retry:",str(ex)[:300])
print("Upload completed as PRIVATE. Review in YouTube Studio.")
