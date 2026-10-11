# Estimates tempo and first-beat offset of a track: python3 bpm.py file
import subprocess,sys,array,math
raw=subprocess.run(["ffmpeg","-v","error","-i",sys.argv[1],"-t","60","-ac","1","-ar","8000","-f","s16le","-"],capture_output=True).stdout
a=array.array('h',raw); H=80  # 10 ms
e=[math.log(1e-3+sum(x*x for x in a[i:i+H])/H) for i in range(0,len(a)-H,H)]
o=[max(0,e[i]-e[i-1]) for i in range(1,len(e))]
best=[]
for lag in range(30,100):
  best.append((sum(o[i]*o[i+lag] for i in range(len(o)-lag))/(len(o)-lag),lag))
best.sort(reverse=True)
for s,l in best[:5]: print("lag",l,"bpm",round(6000/l,2),round(s,4))
lag=best[0][1]
ph=max(range(lag),key=lambda p:sum(o[i] for i in range(p,len(o),lag)))
print("phase_s",(ph+1)/100)
