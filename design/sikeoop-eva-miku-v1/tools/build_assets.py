#!/usr/bin/env python3
"""Build native editable SVG design assets; never modifies application source."""
from pathlib import Path
import base64
import copy
import html
import json
import math
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parents[1]
SVGNS = 'http://www.w3.org/2000/svg'
INKNS = 'http://www.inkscape.org/namespaces/inkscape'
ET.register_namespace('', SVGNS)
ET.register_namespace('inkscape', INKNS)
P = {'bg':'#0B0C14','panel':'#141122','raised':'#1D1930','selected':'#28223E',
     'ink':'#F0EEF8','ink2':'#CEC9DD','muted':'#A6A0B8','faint':'#847B92',
     'line':'#302946','line2':'#514466','cyan':'#5CE1E6','violet':'#9B7BFF',
     'lime':'#C5F66F','pink':'#FF71B8','orange':'#FFB05C','bad':'#FF7C95'}

def path(d, **attrs):
    return '<path d="'+d+'" '+ ' '.join(f'{k.replace("_","-")}="{v}"' for k,v in attrs.items())+'/>'

def line(x1,y1,x2,y2,**attrs):
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '+ ' '.join(f'{k.replace("_","-")}="{v}"' for k,v in attrs.items())+'/>'

def rect(x,y,w,h,fill,rx=0,stroke=None):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"'+(f' stroke="{stroke}"' if stroke else '')+'/>'

def text(x,y,t,size=18,fill=None,weight=400,spacing=None,anchor=None,family=None):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill or P["ink"]}" font-weight="{weight}"'+ (f' letter-spacing="{spacing}"' if spacing else '') + (f' text-anchor="{anchor}"' if anchor else '') + (f' font-family="{family}"' if family else '') +'>'+html.escape(t)+'</text>'

def circle(cx,cy,r,**a):
    return f'<circle cx="{cx}" cy="{cy}" r="{r}" '+ ' '.join(f'{k.replace("_","-")}="{v}"' for k,v in a.items())+'/>'

def group(content, **a):
    return '<g '+ ' '.join(f'{k.replace("_","-")}="{v}"' for k,v in a.items())+'>'+content+'</g>'

def write(name, content):
    out=ROOT/name
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(content,encoding='utf-8')

# Fully native 24px glyphs. The silhouettes are redrawn for this theme rather
# than wrapping the existing artwork in a decorative frame.
D = {
'home': ['M3.5 10 12 3.5 20.5 10v9l-2 2H15v-7H9v7H5.5l-2-2Z'],
'file': ['M5 3.5h9l5 5V19l-2 2H5Z','M14 3.5v5h5','M8 13h8M8 16h5'],
'files': ['M6 3h9l5 5v10H6Z','M15 3v5h5','M3 7v14h13'],
'folder-open': ['M3 8V5.5h6l2 2h9V11','M3 10.5h18l-3 9H3Z'],
'folder-plus': ['M3 7V4.5h6l2 2h10v14H3Z','M9 13h6M12 10v6'],
'index': ['M5 4h14v16H5Z','M8 8h8M8 12h8M8 16h5'],
'book': ['M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3Z','M12 6v15'],
'archive': ['M3 3.5h18v5H3Z','M5 8.5v12h14v-12','M9 13h6'],
'terminal': ['M3 4h18v16H3Z','m7 9 3 3-3 3M13 15h4'],
'globe': ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z','M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18'],
'graph': ['M6 6 18 12 6 18M6 6v12','M4 4h4v4H4ZM16 10h4v4h-4ZM4 16h4v4H4Z'],
'chart': ['M4 3v18h17','M8 16v-5M13 16V6M18 16V9'],
'group': ['M3 21v-4l3-2h5l3 2v4M15 15h3l3 2v4','M8.5 3a4 4 0 1 0 0 8 4 4 0 1 0 0-8M17 4a3 3 0 0 1 0 6'],
'partners': ['M3 20v-4l3-2h5l3 2v4M15 14h3l3 2v4','M8 3a4 4 0 1 0 0 8 4 4 0 1 0 0-8M17 4a3 3 0 0 1 0 6','M6 20h5'],
'brain': ['M12 5v15M12 5 9 3 6 4v3L3 9v5l3 2v3l3 2 3-1 3 1 3-2v-3l3-2V9l-3-2V4l-3-1Z','M6 7h3M18 7h-3M6 16h3M18 16h-3M8 11l4 3 4-3'],
'bug': ['M8 7h8l3 4v7l-3 3H8l-3-3v-7Z','M9 7V4h6v3M12 11v10M2 10l3 2M22 10l-3 2M2 17h3M22 17h-3M5 3l3 4M19 3l-3 4'],
'plugin': ['M3 8h5V4h4v4h8v5h-4v4h4v4H3v-6h4v-4H3Z'],
'hook': ['M4 5h8v9a5 5 0 0 0 10 0v-3','M4 2v6M18 11h4'],
'android': ['M6 8h12l3 4v8H3v-8Z','M7 8 5 4M17 8l2-4M3 14h18M8 20v2M16 20v2','M8 11h.01M16 11h.01'],
'phone': ['M7 2.5h10l2 2v15l-2 2H7l-2-2v-15Z','M9 5h6M10 18.5h4'],
'frame': ['M3 3h7M3 3v7M21 3h-7M21 3v7M3 21h7M3 21v-7M21 21h-7M21 21v-7','M8 8h8v8H8Z'],
'panel-right': ['M3 4h18v16H3Z','M15 4v16M18 9v6'],
'settings': ['M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z','M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8Z'],
'shield-check': ['M12 3 21 7v6l-3 5-6 4-6-4-3-5V7Z','m8 12 3 3 5-6'],
'lock': ['M4 10h16v11H4Z','M7 10V7a5 5 0 0 1 10 0v3M12 14v3'],
'key': ['M8 4a5 5 0 1 0 0 10 5 5 0 1 0 0-10Z','m12 12 9 9M16 16l3-3M18 18l3-3'],
'warning': ['M12 3 22 20H2Z','M12 9v5M12 17h.01'],
'check-circle': ['M12 3h5l4 4v10l-4 4H7l-4-4V7l4-4Z','m7 12 3 3 7-7'],
'check': ['m4 12 5 5L20 6'],
'close': ['m6 6 12 12M18 6 6 18'],
'stop': ['M5 5h14v14H5Z'],
'play': ['M7 3.5 21 12 7 20.5Z'],
'plus': ['M12 4v16M4 12h16'],
'more': ['M4 12h2M11 12h2M18 12h2'],
'chevron-down': ['m5 9 7 7 7-7'],
'chevron-left': ['m15 5-7 7 7 7'],
'chevron-right': ['m9 5 7 7-7 7'],
'arrow-up': ['M12 21V3M5 10l7-7 7 7'],
'send': ['M3 3 22 12 3 21l4-9Z','M7 12h15'],
'attach': ['m9 13 7-7a3 3 0 0 1 4 4L10 20a5 5 0 0 1-7-7L13 3','m6 16 8-8'],
'copy': ['M8 3h13v13H8Z','M16 16v5H3V8h5'],
'trash': ['M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15','M10 10v7M14 10v7'],
'undo': ['M3 10h10a6 6 0 0 1 0 12','m7 5-5 5 5 5'],
'refresh': ['M21 8a9 9 0 0 0-16-2L3 9M3 16a9 9 0 0 0 16 2l2-3','M3 3v6h6M21 21v-6h-6'],
'history': ['M3 10a9 9 0 1 1 1 7','M3 4v6h6M12 7v5l4 3'],
'clock': ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z','M12 6v6l4 3'],
'maximize': ['M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6'],
'minimize': ['M9 3v6H3M15 3v6h6M21 15h-6v6M3 15h6v6'],
'heart': ['M12 21 3.5 12.5V6L7 3l5 4 5-4 3.5 3v6.5Z'],
'sparkle': ['M12 2 15 9l7 3-7 3-3 7-3-7-7-3 7-3Z'],
'chat-plus': ['M3 4h18v13H9l-6 4Z','M12 7v7M8.5 10.5h7'],
'thought': ['M5 4h14l3 4v6l-3 3H8l-3-2H2V8Z','M5 20h2M2 22h1'],
'list-check': ['m3 6 2 2 3-4M11 6h10m-18 8 2 2 3-4M11 14h10M3 21h5M11 21h10'],
'gift': ['M3 9h18v5H3ZM5 14v7h14v-7M12 9v12','M12 9 5 7V3h4l3 6 3-6h4v4Z'],
'help': ['M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18Z','M9 8a3 3 0 1 1 4 3l-1 1v2M12 17h.01'],
'eye-search': ['M2 11c5-8 15-8 20 0-3 4-6 6-10 6-4 0-7-2-10-6Z','M12 7a4 4 0 1 0 0 8 4 4 0 1 0 0-8M15 15l6 6'],
'broom': ['m13 3 7 7M16 6 7 15M5 13l6 6-3 3-7-7Z','m3 17 4 4M6 14l4 4'],
'point-up': ['M9 12V4a2 2 0 0 1 4 0v8M13 10h5l3 3v6l-3 3H9l-6-8 2-2 4 3'],
'rocket': ['M10 14 7 11 12 5l9-2-2 9-6 5Z','M8 10H4l-2 6 6-2M14 16v6l6-3v-5M6 18l-3 3M16 7h.01'],
'stethoscope': ['M3 3v8a5 5 0 0 0 10 0V3M3 3h3M13 3h-3M8 16v1a5 5 0 0 0 10 0v-4','M18 7a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z'],
}

FILE_FRAME = 'M5 3h9l5 5v13H5ZM14 3v5h5'
file_marks = {
'ft-file':['M8 12h8M8 16h5', 'violet'],
'ft-config':['M12 11 15 12v4l-3 1-3-1v-4Z', 'muted'],
'ft-css':['M16 11H9l-1 3h7l-1 4H8','cyan'],
'ft-html':['m10 11-3 3 3 3m4-6 3 3-3 3','orange'],
'ft-image':['M8 17 11 13l2 2 2-3 2 5M9 10h.01','pink'],
'ft-js':['M11 11v6H8M16 11h-3v3h3v3h-3','lime'],
'ft-json':['M10 10H8v3l-1 1 1 1v3h2M14 10h2v3l1 1-1 1v3h-2','orange'],
'ft-md':['M7 17v-6l3 3 3-3v6M17 11v6m-2-2 2 2 2-2','violet'],
'ft-py':['M8 13v-3h6v4H8v4h6v-3M11 11h.01M11 17h.01','lime'],
'ft-ts':['M7 11h6M10 11v7M17 11h-3v3h3v3h-3','cyan'],
}
for n,(d,c) in file_marks.items(): D[n]=[FILE_FRAME,d]
D['ft-folder']=['M3 7V4h6l2 3h10v13H3Z']
D['ft-folder-open']=D['folder-open']

def icon_svg(name):
    filecolor = file_marks[name][1] if name in file_marks else ('violet' if 'folder' in name else None)
    primary = P[filecolor] if filecolor else 'currentColor'
    shapes=''.join(path(d) for d in D[name])
    semantic = 'lime' if name in ['shield-check','check','check-circle','android'] else 'orange' if name=='warning' else 'pink' if name=='heart' else 'cyan'
    # Accent is a small synchronization notch, not a heavy enclosure.
    accent = '' if name.startswith('chevron') or name in ['more','close','plus','arrow-up','check','point-up'] else path('M19 2h3',stroke=f'var(--eva-icon-accent, {P[semantic]})',stroke_width='1.5')
    return f'<svg xmlns="{SVGNS}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke-width="1.65" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">'+group(shapes,id='primary-shape',stroke=primary)+group(accent,id='sync-accent')+'</svg>'

source_names={p.stem for p in (PROJECT/'sweet-code-desktop/src/renderer/src/assets/icons').glob('*.svg')}
if source_names:
    assert source_names == set(D), f'Icon contract mismatch: {source_names ^ set(D)}'
assert len(D) == 72
for name in sorted(D): write(f'icons/ui/{name}.svg',icon_svg(name))

brand_bodies = {
'sikeoop-sync': path('M32 53 9 32V17l10-8 13 11L45 9l10 8v15Z',fill=P['violet'],stroke=P['violet'])+path('M32 45 16 29V20l5-4 11 9 11-9 5 4v9Z',fill=P['bg'],stroke=P['cyan'],stroke_width='2')+path('M32 7V2M22 26l10 5 10-5M6 20v18M58 20v18',fill='none',stroke=P['cyan'],stroke_width='2')+path('M27 35h10',stroke=P['lime'],stroke_width='3'),
'eva-unit01': path('M32 5 38 23 56 18 53 43 40 57H24L11 43 8 18l18 5Z',fill='#4D3E75',stroke=P['violet'],stroke_width='2')+path('m12 26 14 5-6 7-7-3m39-9-14 5 6 7 7-3',fill=P['lime'],stroke='none')+path('M26 43h12l-6 10Z',fill=P['bg'],stroke=P['cyan'],stroke_width='1.5')+path('M32 5v23',stroke=P['lime'],stroke_width='2'),
'miku-signal': path('M21 17 11 11 6 52l12-7 4-21M43 17l10-6 5 41-12-7-4-21',fill='#185E71',stroke=P['cyan'],stroke_width='2')+path('M21 18 26 12h12l5 6v21l-11 8-11-8Z',fill='#28405A',stroke=P['cyan'],stroke_width='2')+path('M23 20 32 28l10-8M24 32h4M36 32h4',stroke=P['cyan'],stroke_width='2')+path('M18 18v15M46 18v15',stroke=P['pink'],stroke_width='4'),
'at-field': path('M16 4h32l16 28-16 28H16L0 32Z',fill='none',stroke=P['violet'],stroke_width='1.5')+path('M21 13h22l11 19-11 19H21L10 32Z',fill='none',stroke=P['cyan'],stroke_width='2')+path('M32 21v22M21 32h22',stroke=P['lime'],stroke_width='1.5'),
'sync-wave': path('M2 32h6M12 24v16M18 16v32M24 27v10M30 6v52M36 18v28M42 25v14M48 14v36M54 27v10M58 32h4',fill='none',stroke=P['cyan'],stroke_width='2.5'),
}
for name, body in brand_bodies.items():
    write(f'icons/brand/{name}.svg',f'<svg xmlns="{SVGNS}" viewBox="0 0 64 64" width="64" height="64"><g id="emblem">{body}</g></svg>')
app_icon=rect(0,0,512,512,P['bg'],104)+path('M104 30h304l74 74v304l-74 74H104l-74-74V104Z',fill=P['panel'],stroke=P['line2'],stroke_width='3')+group(brand_bodies['sikeoop-sync'],transform='translate(96 86) scale(5)')+path('M76 429h100M336 429h100',stroke=P['cyan'],stroke_width='6')+text(256,459,'01 / 39',22,P['muted'],500,6,'middle')
write('icons/brand/app-icon.svg',f'<svg xmlns="{SVGNS}" viewBox="0 0 512 512" width="512" height="512" font-family="system-ui, sans-serif">{app_icon}</svg>')
wordmark=group(brand_bodies['sikeoop-sync'],transform='translate(12 30) scale(1.6)')+text(143,105,'sikeoop',80,P['ink'],650,-3)+text(148,143,'SYNCHRONIZE_01  /  EVA × MIKU',14,P['cyan'],500,3)
write('svg/wordmark.svg',f'<svg xmlns="{SVGNS}" viewBox="0 0 800 176" width="800" height="176" font-family="system-ui, sans-serif">{wordmark}</svg>')

DEFS = '''<linearGradient id="plum" x2="1" y2="1"><stop stop-color="#0B0C14"/><stop offset=".65" stop-color="#141122"/><stop offset="1" stop-color="#21162F"/></linearGradient>
<linearGradient id="armor" x2=".8" y2="1"><stop stop-color="#5B4384"/><stop offset="1" stop-color="#272239"/></linearGradient>
<linearGradient id="hair" x2="1" y2=".7"><stop stop-color="#53D3DC"/><stop offset=".5" stop-color="#278B9D"/><stop offset="1" stop-color="#124B65"/></linearGradient>
<linearGradient id="skin" x2=".7" y2="1"><stop stop-color="#F4E4DC"/><stop offset="1" stop-color="#C9ACA8"/></linearGradient>
<linearGradient id="leftFade"><stop stop-color="#0B0C14" stop-opacity=".96"/><stop offset=".44" stop-color="#0B0C14" stop-opacity=".68"/><stop offset="1" stop-color="#0B0C14" stop-opacity="0"/></linearGradient>
<radialGradient id="aura"><stop stop-color="#544076" stop-opacity=".6"/><stop offset="1" stop-color="#141122" stop-opacity="0"/></radialGradient>
<pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse"><path d="M80 0H0v80" fill="none" stroke="#423753" stroke-width=".6"/></pattern>
<pattern id="hazard" width="32" height="20" patternUnits="userSpaceOnUse" patternTransform="skewX(-35)"><rect width="16" height="20" fill="#FFB05C"/><rect x="16" width="16" height="20" fill="#141122"/></pattern>
<clipPath id="editorClip"><rect x="368" y="54" width="904" height="1054"/></clipPath>
<clipPath id="windowClip"><rect width="1920" height="1140" rx="18"/></clipPath>'''

def hexagon(cx,cy,r):
    points=[(cx+r*math.cos(math.pi/3*i),cy+r*math.sin(math.pi/3*i)) for i in range(6)]
    return 'M'+' '.join(f'{x:.2f},{y:.2f}' for x,y in points)+'Z'

def waveform(x,y,w=230,h=55):
    values=[.14,.21,.11,.35,.23,.5,.33,.8,.55,.95,.72,.45,.64,.24,.37,.23,.47,.17,.28,.14,.12,.08]
    return ''.join(line(x+i*w/len(values),y-v*h/2,x+i*w/len(values),y+v*h/2,stroke=P['cyan'],stroke_width='2',opacity=f'{.35+.6*v:.2f}') for i,v in enumerate(values))

def layer(i,label,body,**attrs):
    extra=' '.join(f'{k.replace("_","-")}="{v}"' for k,v in attrs.items())
    return f'<g id="{i}" inkscape:groupmode="layer" inkscape:label="{html.escape(label)}" {extra}>{body}</g>'

def master(filename,w,h,layers,desc):
    content=f'<svg xmlns="{SVGNS}" xmlns:inkscape="{INKNS}" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="Inter, -apple-system, PingFang SC, Microsoft YaHei, sans-serif"><title>SIKEOOP / SYNCHRONIZE_01</title><desc>{html.escape(desc)}</desc><defs>{DEFS}</defs>'+''.join(layers)+'</svg>'
    write('svg/'+filename,content)
    tree=ET.fromstring(content)
    layer_entries=[]
    prefix=Path(filename).stem
    for el in tree:
        if el.tag==f'{{{SVGNS}}}g' and el.get(f'{{{INKNS}}}groupmode')=='layer':
            standalone=ET.Element(tree.tag,tree.attrib)
            for d in tree:
                if d.tag==f'{{{SVGNS}}}defs': standalone.append(copy.deepcopy(d))
            standalone.append(copy.deepcopy(el))
            name=f'{prefix}--{el.get("id")}.svg'
            write('svg/layers/'+name,ET.tostring(standalone,encoding='unicode'))
            layer_entries.append({'id':el.get('id'),'label':el.get(f'{{{INKNS}}}label'),'file':'svg/layers/'+name})
    return layer_entries

# A native-vector reinterpretation of the anime key visual. Raster illustration
# and vector illustration are intentionally separate assets, not a false trace.
ART=[]
ART.append(layer('background','01 · 深紫黑底',rect(0,0,1920,1080,'url(#plum)')))
ART.append(layer('engineering-grid','02 · 工程网格',rect(0,0,1920,1080,'url(#grid)')+path('M46 80v680h165M76 58h210M61 798h35M560 80 733 253M1900 630v402h-88',fill='none',stroke=P['line2'],stroke_width='1'),opacity='.25'))
ART.append(layer('at-field-rings','03 · AT 立场环',circle(1370,510,565,fill='url(#aura)')+''.join(path(hexagon(1370,500,r),fill='none',stroke=P['violet'] if i%2 else P['cyan'],stroke_width='1.1',opacity=str(.12+i*.015)) for i,r in enumerate([310,333,360,480,505]))+circle(360,415,430,fill='none',stroke=P['line2'],stroke_width='1',opacity='.6')))
mecha_body=path('M1250 142 1530 60 1815 172 1878 453 1744 718 1560 858 1364 729 1190 469Z',fill='#171623',stroke='#615077',stroke_width='3')+path('M1400 624 1250 686 1158 1080H1905l-15-390-170-71Z',fill='#242033',stroke='#615077',stroke_width='3')+path('M1260 205 936 77l410 331Z',fill='#392B55',stroke=P['violet'],stroke_width='2')
ART.append(layer('eva-silhouette','04 · EVA 机体轮廓',mecha_body))
panels=path('M1265 190 1529 90l-67 249-137 125-86-61Z',fill='url(#armor)',stroke='#695384',stroke_width='2')+path('M1552 91 1788 193l54 229-128 53-223-137Z',fill='url(#armor)',stroke='#695384',stroke_width='2')+path('M1335 465 1456 363l199 9 87 127-136 156-139-37Z',fill='#44365E',stroke='#8A689C',stroke_width='2')+path('M1294 694 1379 656l86 158-37 266h-271Z',fill='url(#armor)',stroke='#6B5381',stroke_width='2')+path('M1790 660 1888 731l16 349h-176l-97-280Z',fill='url(#armor)',stroke='#6B5381',stroke_width='2')
ART.append(layer('eva-armor','05 · 紫色装甲面',panels))
mecha_acc=path('m1265 294 137 72-61 39-83-42Z',fill=P['lime'])+path('m1661 358 172-66-9 65-110 52Z',fill=P['lime'])+path('M1529 90 1462 339l-22 14 43-222Z',fill=P['lime'])+path('M1260 705 1326 678l50 94-89-4Z',fill=P['lime'])+path('M1804 690 1865 737l6 105-69-35Z',fill=P['lime'])+path('M1508 422h47l28 47-21 42h-52l-18-38Z',fill='#16171F',stroke='#9388A7',stroke_width='2')+path('M1474 534h107l-37 71-35 4Z',fill='#181824')+path('M1489 551h71M1484 565h78M1527 422v86',stroke='#83758E',stroke_width='2')+path('M1322 275h32M1710 232h34',stroke=P['orange'],stroke_width='9')
ART.append(layer('eva-lights','06 · 机体荧光与硬件',mecha_acc))

# Character local coordinate system (520×780), with every part independently
# registered on the same 1920×1080 artboard.
T='translate(1270 325) scale(.98)'
hair_back=path('M118 126C5 61-78 210-134 365S-253 549-376 621C-154 596-2 449 51 306L37 529C-14 646-122 713-228 760 34 750 101 606 133 455l49-164Z',fill='url(#hair)',stroke='#173F55',stroke_width='3')+path('M361 114c134-45 156 122 184 270s93 250 167 344c-160-61-237-249-251-421l-6 177c14 122 74 227 149 296-169-51-249-216-265-390Z',fill='url(#hair)',stroke='#163F55',stroke_width='3')+path('M87 155C-26 326-25 516-204 688M424 157c79 191 12 363 152 563',fill='none',stroke='#46ADB7',stroke_width='4')+path('M113 194C23 382 54 554-98 668M448 199c26 158 6 290 76 413',fill='none',stroke='#164B61',stroke_width='8')
ART.append(layer('miku-hair-back','07 · 初音后发与双马尾',group(hair_back,transform=T)))
suit=path('M185 316 167 395l-99 50-42 88-53 221h541l-51-221-56-92-108-44-4-76Z',fill='#1D2130',stroke='#6C6178',stroke_width='3')+path('M173 371h138l26 83-92 110-83-100Z',fill='#363146',stroke='#70627D',stroke_width='2')+path('M72 445 169 427l-8 183-39 144H-20l48-221Z',fill='url(#armor)',stroke='#65577A',stroke_width='2')+path('M328 429 411 446l51 91 41 217H378l-61-171Z',fill='url(#armor)',stroke='#65577A',stroke_width='2')+path('M164 500 247 552l85-60-14 121 55 141H116l49-144Z',fill='#29243C',stroke='#574E66',stroke_width='2')+path('M215 417h49l18 111-30 34-36-26Z',fill=P['cyan'])+path('M236 573v180M167 455l-29 144-29 153M332 457l24 137 28 159',fill='none',stroke=P['cyan'],stroke_width='4')+path('M69 463 112 445l20 33-60 17ZM371 448l42 29-5 39-55-22Z',fill=P['lime'])+path('M183 635h35M273 635h33',stroke=P['pink'],stroke_width='6')+circle(248,688,13,fill='#BD834A',stroke='#2D2233',stroke_width='4')+text(397,563,'01',34,'#171321',750,None,'middle')
ART.append(layer('miku-pilot-suit','08 · 初音驾驶服与装甲',group(suit,transform=T)))
face=path('M193 302v75c12 33 61 35 88-1l3-71Z',fill='url(#skin)',stroke='#AE969B',stroke_width='2')+path('M146 151c-13 59-12 141 25 178l70 36 65-27c51-31 79-109 60-178-18-65-159-93-220-9Z',fill='url(#skin)',stroke='#7A777E',stroke_width='2.5')+path('M344 203c31-11 25 46-2 52',fill='#D2B3AD',stroke='#A59298',stroke_width='2')+path('M201 284c11 5 22 6 31 1M254 321c13 7 28 5 37-4',fill='none',stroke='#A2777D',stroke_width='2')+path('M206 270l-6 11 11 3',fill='none',stroke='#AD8B91',stroke_width='1.8')
eyes=path('M161 235c25-24 57-19 74-1-24 18-48 19-74 1ZM274 228c23-20 53-15 68 0-23 19-42 19-68 0Z',fill='#F6F1ED',stroke='#293242',stroke_width='3')+path('M185 227v16c11 14 30 7 32-4v-12ZM296 221v17c10 13 27 4 28-8v-9Z',fill='#3BA6A5',stroke='#2A555F',stroke_width='1.5')+path('M198 226v16M309 222v13',stroke='#163B4E',stroke_width='6')+circle(202,230,3,fill='#EFFDFC')+circle(312,224,3,fill='#EFFDFC')+path('M161 233c25-23 56-19 74 0M274 227c23-21 53-16 69 0M173 212l37-7M287 204l38 5',fill='none',stroke='#293747',stroke_width='3')
ART.append(layer('miku-face','09 · 初音脸部与表情',group(face+eyes,transform=T)))
bangs=path('M136 222c-41-80-6-185 61-206 68-29 143-5 173 64 31 26 37 77 19 129l-30 94-28-72 8-92-21 68-42-83 8 96-73-89 24 105-83-83 9 97-23 76Z',fill='url(#hair)',stroke='#194C61',stroke_width='3')+path('M160 67c37-24 86-25 128 8M136 167l29-77 62 98M204 39l71 90M296 61l35 84M357 91l-2 75',fill='none',stroke='#64D9DE',stroke_width='3')+path('M145 241 117 418l64-63-17-99M358 236l-31 134 67 105-24-209',fill='url(#hair)',stroke='#194C61',stroke_width='2.5')
ART.append(layer('miku-front-hair','10 · 初音刘海与侧发',group(bangs,transform=T)))
headset=path('M126 152 91 108l-21 7 43 65Z',fill='#23202E',stroke=P['pink'],stroke_width='5')+path('M352 108 390 64l22 14-38 56Z',fill='#252130',stroke=P['pink'],stroke_width='5')+path('M132 184h-22v65l20 16 22-14v-53Z',fill='#1A1B26',stroke='#736282',stroke_width='3')+path('M116 193v46',stroke=P['pink'],stroke_width='6')+path('M372 187h20v61l-21 14-22-13v-52Z',fill='#1A1B26',stroke='#736282',stroke_width='3')+path('M384 194v43',stroke=P['pink'],stroke_width='6')+path('M368 251l-22 38h-32',fill='none',stroke='#313147',stroke_width='4')+rect(305,284,17,7,P['cyan'],3)
ART.append(layer('miku-headset','11 · 初音耳机与麦克风',group(headset,transform=T)))
contour=path('M930 1060c184-97 273-302 332-502M1768 926l-24-94M1418 360c30-31 57-44 88-39',fill='none',stroke=P['cyan'],stroke_width='2',opacity='.65')
ART.append(layer('rim-lights','12 · 轮廓光',contour))
hud=path('M78 835h185l27-27h242M78 862h78M1825 60h46v82M1840 975h34v44h-66',fill='none',stroke=P['cyan'],stroke_width='1.5',opacity='.6')+group(waveform(83,904,330,60),opacity='.75')+path(hexagon(813,810,100),fill='none',stroke=P['violet'],stroke_width='1.3',opacity='.6')+text(814,803,'01 / 39',26,P['cyan'],500,2,'middle')+text(813,830,'SYNCHRONIZATION',9,P['muted'],500,1,'middle')+rect(70,1009,187,9,'url(#hazard)')+text(282,1020,'UNIT 01 / VOCAL SIGNAL 39',11,P['muted'],450,2)
ART.append(layer('hud-decorations','13 · HUD 波形与警戒标',hud))
wm=text(80,487,'SYNCHRONIZE',69,P['ink'],700,1)+text(83,546,'_01',70,P['cyan'],400,1)+text(84,594,'EVA × MIKU / SIKEOOP',18,P['violet'],500,6)+text(86,714,'BUILD SOMETHING THAT FEELS ALIVE.',13,P['muted'],400,2)
ART.append(layer('theme-wordmark','14 · 可编辑主题标题',wm))
theme_layers=master('theme-vector-layered.svg',1920,1080,ART,'Original native vector reinterpretation. All 14 groups are editable artwork; no embedded raster image. This is not an exact vector tracing of theme-wallpaper.png.')

# Compose the UI with genuine independently selectable vector surfaces.
wallpaper=(ROOT/'images/theme-wallpaper.png').read_bytes()
data_uri='data:image/png;base64,'+base64.b64encode(wallpaper).decode()
UI=[]
UI.append(layer('window-background','01 · 窗口底板',rect(0,0,1920,1140,P['bg'],18)))
art_markup=f'<image x="368" y="54" width="904" height="1054" href="{data_uri}" preserveAspectRatio="xMaxYMid slice"/>'+rect(368,54,904,1054,'url(#leftFade)')
UI.append(layer('wallpaper-raster','02 · 主插画（单个位图层）',art_markup,clip_path='url(#editorClip)'))
UI.append(layer('functional-panels','03 · 功能面板',rect(0,54,64,1054,P['bg'])+rect(64,54,304,1054,P['panel'])+rect(1272,54,648,1054,P['panel'])+rect(0,0,1920,54,P['bg'])+rect(0,1108,1920,32,P['bg'])))
dividers=''.join(line(x,54,x,1108,stroke=P['line'],stroke_width='1') for x in [64,368,1272])+line(0,54,1920,54,stroke=P['line'],stroke_width='1')+line(0,1108,1920,1108,stroke=P['line'],stroke_width='1')+line(64,112,368,112,stroke=P['line'],stroke_width='1')+line(1272,112,1920,112,stroke=P['line'],stroke_width='1')
UI.append(layer('panel-dividers','04 · 面板分隔与边角',dividers+path('M0 138v52M368 438v46',stroke=P['cyan'],stroke_width='3')+path('M1730 1138h128l39-28',fill='none',stroke=P['violet'],stroke_width='2')))

def ui_icon(n,x,y,size=24,color=None):
    stroke=color or P['cyan']
    return group(''.join(path(d) for d in D[n]),transform=f'translate({x} {y}) scale({size/24})',fill='none',stroke=stroke,stroke_width='1.65',stroke_linecap='square',stroke_linejoin='miter')

title=circle(23,26,8,fill='#FF615C')+circle(47,26,8,fill='#FFBD44')+circle(71,26,8,fill='#00C94B')+group(brand_bodies['sikeoop-sync'],transform='translate(96 10) scale(.5)')+text(140,34,'sikeoop',19,P['ink'],650)+text(240,34,'/  EVA × MIKU',17,P['violet'],450)+rect(771,0,376,45,P['bg'],16,P['line2'])+group(waveform(834,24,171,19))+text(1041,31,'02:56',18,P['ink'],600)+circle(1122,24,5,fill=P['lime'])+rect(1640,9,263,35,P['panel'],18,P['line2'])+group(brand_bodies['miku-signal'],transform='translate(1649 12) scale(.46)')+text(1686,33,'MIKU / ONLINE',15,P['cyan'],500,1)+ui_icon('chevron-down',1873,19,14,P['muted'])
UI.append(layer('titlebar','05 · 标题栏与同步岛',title))
navnames=['home','files','graph','index','archive','chat-plus','clock','phone','send','list-check','shield-check','chart','group','gift','plugin','bug','brain','help','settings']
nav=rect(8,121,48,49,P['raised'],8,P['line2'])
for i,n in enumerate(navnames): nav+=ui_icon(n,20,78+i*53,24,P['cyan'] if i<4 or i==18 else P['muted'])
UI.append(layer('navigation-icons','06 · 导航图标',nav))
expl=text(83,90,'资源管理器',17,P['ink2'],600)+ui_icon('refresh',330,72,20,P['muted'])+rect(65,441,302,38,'#163039')
rows=[('.claude','ft-folder',0),('.sikeoop','ft-folder-open',0),('agents','ft-folder',1),('workspace.json','ft-json',1),('src','ft-folder-open',0),('components','ft-folder',1),('screens','ft-folder',1),('theme.css','ft-css',1),('README.md','ft-md',1),('android-emulator','ft-folder',0),('cli-design','ft-folder',0),('harmony-agents','ft-folder',0),('harmony-emulator','ft-folder',0),('memory-design','ft-folder',0),('mobile','ft-folder',0),('android','ft-folder',1),('mobile-design','ft-folder',0),('protocol','ft-folder',0),('sweet-code-desktop','ft-folder-open',0),('package.json','ft-json',1),('README.md','ft-md',1)]
for i,(name,icon,indent) in enumerate(rows):
    y=140+i*43
    if icon.startswith('ft-folder'): expl+=ui_icon('chevron-down' if 'open' in icon else 'chevron-right',82+indent*18,y+2,13,P['muted'])
    color=P['violet'] if 'folder' in icon else P[file_marks[icon][1]]
    expl+=ui_icon(icon,110+indent*18,y-1,21,color)+text(142+indent*18,y+16,name,16,P['cyan'] if name=='theme.css' else P['ink2'])
UI.append(layer('explorer','07 · 资源管理器',expl))
hero=text(410,294,'SYNCHRONIZE',39,P['ink'],750,1)+text(410,344,'_01',48,P['cyan'],450,3)+text(412,388,'EVA × MIKU / SIKEOOP',14,P['violet'],500,3)+path(hexagon(511,534,93),fill='none',stroke=P['violet'],stroke_width='1.5',opacity='.8')+path(hexagon(511,534,73),fill='none',stroke=P['cyan'],stroke_width='1.5',opacity='.7')+text(511,539,'01 / 39',25,P['cyan'],500,1,'middle')+text(511,564,'SYNCHRONIZATION',9,P['muted'],500,1,'middle')+waveform(427,635,177,40)+text(413,704,'CODE / CONNECT / CREATE',12,P['muted'],400,1.5)
UI.append(layer('welcome-typography','08 · 欢迎页标题与 HUD',hero))
launch=''
for i,(name,ico) in enumerate([('Open project','folder-open'),('New session','chat-plus'),('Terminal','terminal')]):
    x=410+i*267
    launch+=rect(x,920,247,140,'#151223',12,P['line2'])+ui_icon(ico,x+25,947,34)+text(x+25,1027,name,19,P['ink'])+ui_icon('chevron-right',x+212,1007,18,P['muted'])
UI.append(layer('launch-cards','09 · 启动按钮',launch))
chat=text(1323,90,'AI 伙伴',19,P['ink'],600)+ui_icon('sparkle',1290,70,22,P['violet'])+ui_icon('chat-plus',1764,71,20,P['muted'])+ui_icon('history',1806,71,20,P['muted'])+ui_icon('maximize',1848,71,20,P['muted'])+ui_icon('close',1885,72,20,P['muted'])+group(brand_bodies['miku-signal'],transform='translate(1297 145) scale(.7)')+text(1358,170,'MIKU',16,P['cyan'],600)+text(1415,170,'02:56',13,P['muted'])+rect(1357,190,210,48,P['raised'],10)+text(1374,221,'主题已同步。',17)+rect(1357,251,338,49,P['raised'],10)+text(1374,282,'文件、终端和对话已就绪。',17)+rect(1357,331,529,134,'#100F1C',12,P['line2'])+line(1357,375,1886,375,stroke=P['line'],stroke_width='1')+ui_icon('terminal',1373,344,21)+text(1406,360,'synchronization',15,P['muted'])+ui_icon('copy',1846,346,17,P['muted'])+text(1379,407,'1',14,P['faint'])+text(1410,407,'synchronization: 100%',16,P['cyan'],400,None,None,'SFMono-Regular, Menlo, monospace')+text(1379,440,'2',14,P['faint'])+text(1410,440,'status: ready',16,P['lime'],400,None,None,'SFMono-Regular, Menlo, monospace')+rect(1357,487,529,84,'#11111D',12,P['line2'])+ui_icon('shield-check',1379,509,34,P['lime'])+text(1428,521,'READY',26,P['lime'],650)+text(1429,547,'ALL SYSTEMS SYNCHRONIZED',11,P['muted'],450,2)
UI.append(layer('chat-content','10 · 对话内容与结果卡',chat))
composer=rect(1297,909,599,174,P['raised'],15,P['line2'])+path('M1305 910h512l16-15h61',fill='none',stroke=P['violet'],stroke_width='1')+text(1321,950,'告诉我你想做什么…',18,P['muted'])+rect(1318,1020,127,40,'#32233F',7,'#654478')+text(1337,1047,'长任务',16,P['pink'])+ui_icon('chevron-down',1415,1032,16,P['pink'])+ui_icon('attach',1785,1031,23,P['ink2'])+circle(1856,1042,23,fill=P['bg'],stroke=P['cyan'],stroke_width='1.5')+ui_icon('arrow-up',1844,1030,24,P['cyan'])
UI.append(layer('composer','11 · 消息输入与动作',composer))
status=path('M22 1129l6-8M29 1129l6-8M36 1129l6-8',stroke=P['cyan'],stroke_width='2')+text(52,1130,'SIKEOOP / UNIT 01',13,P['cyan'],500,1)+ui_icon('terminal',360,1117,17,P['muted'])+text(390,1130,'就绪',13,P['muted'])+text(1640,1130,'SYNC 100%   UTF-8',13,P['muted'],400,1)+rect(1847,1117,52,9,'url(#hazard)')
UI.append(layer('statusbar','12 · 状态栏',status))
ui_layers=master('ui-skin-layered.svg',1920,1140,UI,'12 editable SVG layers. The master illustration is ONE embedded raster layer; every panel, icon, control, label and HUD element is real vector content. Design prototype, not a running application.')

vector_art=''.join(ART[1:13])
vector_ui=UI.copy()
vector_ui[1]=layer('wallpaper-vector','02 · 纯矢量主题插画',group(vector_art,transform='translate(-415 90) scale(.9)')+rect(368,54,904,1054,'url(#leftFade)'),clip_path='url(#editorClip)')
vector_ui_layers=master('ui-skin-vector-only.svg',1920,1140,vector_ui,'All-vector UI design prototype with no raster images. The illustration is a geometric reinterpretation rather than an exact reproduction of the generated key visual.')

sprite=[]
for name in sorted(D):
    e=ET.fromstring(icon_svg(name)); body=''.join(ET.tostring(c,encoding='unicode') for c in e)
    # IDs must be unique when multiple symbols are in the same document.
    body=body.replace('id="primary-shape"',f'id="{name}-primary"').replace('id="sync-accent"',f'id="{name}-accent"')
    sprite.append(f'<symbol id="{name}" viewBox="0 0 24 24" fill="none" stroke-width="1.65" stroke-linecap="square" stroke-linejoin="miter">{body}</symbol>')
for name,body in brand_bodies.items(): sprite.append(f'<symbol id="{name}" viewBox="0 0 64 64">{body}</symbol>')
write('icons/sprite.svg',f'<svg xmlns="{SVGNS}">'+''.join(sprite)+'</svg>')

entries=[('ui',n) for n in sorted(D)]+[('brand',n) for n in sorted(brand_bodies)]+[('brand','app-icon')]
sheet=rect(0,0,1600,1310,P['bg'])+text(54,63,'SIKEOOP / ICON SYSTEM',30,P['ink'],600,2)+text(54,95,'EVA × MIKU · 72 compatible UI icons + 6 brand assets',15,P['muted'])
for i,(kind,name) in enumerate(entries):
    x=48+(i%10)*151; y=133+(i//10)*136
    sheet+=rect(x,y,139,123,P['panel'],9,P['line'])
    if kind=='ui':
        # Reuse the exact same icon SVG contents that ship in the pack.
        e=ET.fromstring(icon_svg(name)); b=''.join(ET.tostring(c,encoding='unicode') for c in e)
        b=b.replace('id="primary-shape"',f'id="sheet-{name}-primary"').replace('id="sync-accent"',f'id="sheet-{name}-accent"')
        sheet+=group(b,transform=f'translate({x+47} {y+19}) scale(1.85)',color=P['cyan'],fill='none',stroke_width='1.65',stroke_linecap='square',stroke_linejoin='miter')
    elif name=='app-icon': sheet+=group(app_icon,transform=f'translate({x+42} {y+12}) scale(.11)')
    else: sheet+=group(brand_bodies[name],transform=f'translate({x+42} {y+13}) scale(.88)')
    sheet+=text(x+69.5,y+98,name,11,P['ink2'],400,None,'middle')
sheet+=text(54,1270,'24px grid · 1.65px angular strokes · currentColor + synchronization accents',15,P['muted'])
write('svg/icon-contact-sheet.svg',f'<svg xmlns="{SVGNS}" width="1600" height="1310" viewBox="0 0 1600 1310" font-family="system-ui, sans-serif">{sheet}</svg>')

tokens={'id':'sikeoop-eva-miku-v1','name':'SYNCHRONIZE_01 / EVA × MIKU','version':'1.0.0','status':'design-assets-not-applied','palette':P,'cssVariables':{
'--bg':P['bg'],'--panel':P['panel'],'--panel-2':P['raised'],'--panel-3':P['selected'],'--editor':P['bg'],'--ink':P['ink'],'--ink-2':P['ink2'],'--muted':P['muted'],'--faint':P['faint'],'--line':P['line'],'--line-2':P['line2'],'--accent':P['cyan'],'--accent-ink':'#0C1C26','--accent-soft':'rgba(92,225,230,0.12)','--primary':P['cyan'],'--primary-ink':'#0C1C26','--ok':P['lime'],'--bad':P['bad'],'--warn':P['orange'],'--code-bg':P['bg'],'--add-bg':'rgba(197,246,111,0.10)','--add-ink':P['lime'],'--del-bg':'rgba(255,124,149,0.10)','--del-ink':P['bad'],'--shadow':'0 12px 32px rgba(0,0,0,0.48)','--radius':'8px','--eva-violet':P['violet'],'--eva-pink':P['pink'],'--eva-icon-accent':P['cyan']},'typography':{'ui':'Geist Variable, PingFang SC, system-ui, sans-serif','code':'Geist Mono Variable, SF Mono, Menlo, monospace'},'assetPaths':{'wallpaper':'../images/theme-wallpaper.png','icons':'../icons/ui/','brand':'../icons/brand/','layeredUI':'../svg/ui-skin-layered.svg','layeredVectorTheme':'../svg/theme-vector-layered.svg'},'iconContract':{'sourceCount':72,'generatedCount':len(D),'names':sorted(D)}}
write('theme/tokens.json',json.dumps(tokens,ensure_ascii=False,indent=2)+'\n')
scope=':root[data-sikeoop-theme="eva-miku"]'
css='/* Design pack. Import after the existing theme.css; opt in with the root attribute. */\n'+scope+' {\n'+''.join(f'  {k}: {v};\n' for k,v in tokens['cssVariables'].items())+'  color-scheme: dark;\n}\n'
css+='''
:root[data-sikeoop-theme="eva-miku"] .activitybar button.on {
  background: var(--panel-2); color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--line-2);
}
:root[data-sikeoop-theme="eva-miku"] .tree-row.active {
  background: rgba(92,225,230,.10); color: var(--accent);
}
:root[data-sikeoop-theme="eva-miku"] .composer-box:focus-within {
  border-color: var(--accent); box-shadow: 0 0 0 1px rgba(92,225,230,.12);
}
:root[data-sikeoop-theme="eva-miku"] .titlebar,
:root[data-sikeoop-theme="eva-miku"] .statusbar {
  background-image: linear-gradient(110deg, #0B0C14 60%, #21172D);
}
:root[data-sikeoop-theme="eva-miku"] .editor-empty {
  position: relative; isolation: isolate;
  background: var(--editor);
}
:root[data-sikeoop-theme="eva-miku"] .editor-empty::before {
  content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
  background-image: linear-gradient(90deg, rgba(11,12,20,.94), rgba(11,12,20,.42)), url("../images/theme-wallpaper.png");
  background-position: center, right center; background-size: cover; background-repeat: no-repeat;
}
:root[data-sikeoop-theme="eva-miku"] .editor-empty .inner {
  padding: 24px; border: 1px solid var(--line-2); border-radius: 12px;
  background: rgba(20,17,34,.94); color: var(--ink-2);
}
:root[data-sikeoop-theme="eva-miku"] .editor-empty .mark {
  color: var(--accent); background: var(--panel-2);
}
:root[data-sikeoop-theme="eva-miku"] ::selection { background: rgba(92,225,230,.25); }
:root[data-sikeoop-theme="eva-miku"] ::-webkit-scrollbar-thumb { background-color: var(--line-2); }
'''
write('theme/sikeoop-eva-miku.css',css)
monaco={'base':'vs-dark','inherit':True,'rules':[{'token':'comment','foreground':'A6A0B8','fontStyle':'italic'},{'token':'keyword','foreground':'9B7BFF'},{'token':'string','foreground':'C5F66F'},{'token':'number','foreground':'FFB05C'},{'token':'type','foreground':'5CE1E6'},{'token':'delimiter','foreground':'CEC9DD'},{'token':'invalid','foreground':'FF7C95'}],'colors':{'editor.background':'#0B0C14','editor.foreground':'#F0EEF8','editorLineNumber.foreground':'#847B92','editorLineNumber.activeForeground':'#5CE1E6','editorCursor.foreground':'#5CE1E6','editor.selectionBackground':'#28424F','editor.inactiveSelectionBackground':'#28223E','editor.lineHighlightBackground':'#141122','editorIndentGuide.background1':'#302946','editorIndentGuide.activeBackground1':'#514466','editorWidget.background':'#1D1930','editorWidget.border':'#514466','editorSuggestWidget.selectedBackground':'#28223E'}}
write('theme/monaco-theme.json',json.dumps(monaco,ensure_ascii=False,indent=2)+'\n')
terminal={'background':P['bg'],'foreground':P['ink'],'cursor':P['cyan'],'cursorAccent':P['bg'],'selectionBackground':'#28424F','black':'#141122','red':P['bad'],'green':P['lime'],'yellow':P['orange'],'blue':P['violet'],'magenta':P['pink'],'cyan':P['cyan'],'white':P['ink2'],'brightBlack':P['faint'],'brightRed':'#FF9DAD','brightGreen':'#D8FF9C','brightYellow':'#FFD08C','brightBlue':'#B7A0FF','brightMagenta':'#FFA0CC','brightCyan':'#A0F4F6','brightWhite':P['ink']}
write('theme/terminal-theme.json',json.dumps(terminal,indent=2)+'\n')
write('layers.json',json.dumps({'ui':ui_layers,'vectorUI':vector_ui_layers,'vectorTheme':theme_layers},ensure_ascii=False,indent=2)+'\n')

gallery=''
for kind,name in entries:
    if kind=='ui':
        glyph=icon_svg(name).replace('id="primary-shape"',f'id="gallery-{name}-primary"').replace('id="sync-accent"',f'id="gallery-{name}-accent"')
    else:
        glyph=f'<img src="icons/{kind}/{name}.svg" alt="{name}">'
    gallery+=f'<a class="icon-card" href="icons/{kind}/{name}.svg" download>{glyph}<code>{name}</code></a>'
layer_checkboxes=''.join(f'<label><input type="checkbox" checked data-layer="{e["id"]}">{html.escape(e["label"])}</label>' for e in ui_layers)
# Embed the exact master as inline SVG so controls also work from a file:// URL.
inline_ui=(ROOT/'svg/ui-skin-layered.svg').read_text()
page='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SIKEOOP / SYNCHRONIZE_01</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#0B0C14;color:#F0EEF8;font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}a{color:#5CE1E6;text-decoration:none}a:hover{text-decoration:underline}.wrap{max-width:1480px;margin:auto;padding:40px}header{display:flex;align-items:center;justify-content:space-between;gap:24px;border-bottom:1px solid #302946;padding-bottom:28px}h1{font-size:44px;letter-spacing:-1.5px;margin:8px 0}h2{font-size:25px;margin:0 0 14px}.eyebrow{color:#5CE1E6;letter-spacing:3px;font-size:12px}p{color:#A6A0B8;margin:7px 0}.tag{padding:8px 16px;border:1px solid #514466;border-radius:6px;font-size:12px;color:#C5F66F;white-space:nowrap}.nav{display:flex;gap:25px;flex-wrap:wrap;padding:20px 0 10px}.section{padding-top:42px}.hero{width:100%;display:block;border:1px solid #514466;border-radius:14px;margin-top:20px}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:25px}.panel{padding:22px;background:#141122;border:1px solid #302946;border-radius:12px}.panel img{width:100%;border-radius:8px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}.actions a{display:block;padding:9px 14px;border:1px solid #514466;border-radius:6px}.palette{display:grid;grid-template-columns:repeat(7,1fr);gap:12px}.swatch{height:86px;border-radius:8px;border:1px solid #514466}.swatch-label{font:12px/1.6 monospace;color:#CEC9DD;margin-top:8px}.stage{border:1px solid #514466;border-radius:12px;overflow:hidden;background:#211D2C}.stage svg{width:100%;height:auto;display:block}.layer-controls{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-top:18px}.layer-controls label{font-size:13px;cursor:pointer}.layer-controls input{accent-color:#5CE1E6;margin-right:8px}.icons{display:grid;grid-template-columns:repeat(8,1fr);gap:12px}.icon-card{display:flex;flex-direction:column;align-items:center;gap:15px;padding:20px 8px;background:#141122;border:1px solid #302946;border-radius:8px;color:#CEC9DD}.icon-card img{width:36px;height:36px}.icon-card code{font-size:11px}.icon-card:hover{border-color:#5CE1E6;text-decoration:none}.note{border-left:3px solid #FFB05C;padding:12px 20px;margin-top:20px;background:#141122}footer{margin:50px 0 10px;color:#A6A0B8;font-size:13px}button{background:#28223E;border:1px solid #514466;color:#F0EEF8;padding:7px 12px;border-radius:5px;cursor:pointer}.button-row{display:flex;gap:10px;margin:12px 0}#layer-note{color:#C5F66F;font-size:12px}button:focus-visible,a:focus-visible{outline:2px solid #5CE1E6;outline-offset:3px}@media(max-width:900px){.wrap{padding:20px}.twocol{grid-template-columns:1fr}.icons{grid-template-columns:repeat(4,1fr)}.palette{grid-template-columns:repeat(4,1fr)}.layer-controls{grid-template-columns:1fr 1fr}h1{font-size:30px}header{display:block}.tag{display:inline-block;margin-top:15px}}
</style></head><body><div class="wrap"><header><div><div class="eyebrow">SIKEOOP / THEME DESIGN SYSTEM</div><h1>SYNCHRONIZE_01</h1><p>EVA × 初音未来 · 机甲骨架 / 音色灵魂</p></div><span class="tag">DESIGN PACK / NOT APPLIED</span></header><nav class="nav"><a href="#effect">效果图</a><a href="#theme">单张主题</a><a href="#layers">SVG 分层</a><a href="#icons">78 个图标</a><a href="README.md">交付说明</a></nav>
<section id="effect" class="section"><h2>01 / 整窗皮肤效果</h2><p>内置 image_gen 生成，沿用原有导航、文件树、工作区、AI 对话和状态栏布局。</p><img class="hero" src="images/app-effect.png" alt="sikeoop EVA 初音主题整窗效果图"><div class="actions"><a href="images/app-effect.png" download>下载效果图 PNG</a><a href="svg/ui-skin-layered.svg" download>UI 分层 SVG</a><a href="svg/ui-skin-vector-only.svg" download>全矢量 UI SVG</a></div></section>
<section id="theme" class="section"><h2>02 / 独立主题与矢量版本</h2><div class="twocol"><div class="panel"><img src="images/theme-wallpaper.png" alt="EVA 初音主题壁纸"><h3>完整动漫主视觉 / PNG</h3><p>安静的左侧留白，右侧初音驾驶员与初号机。</p><a href="images/theme-wallpaper.png" download>下载单张主题图</a></div><div class="panel"><img src="svg/theme-vector-layered.svg" alt="纯矢量主题图"><h3>原生矢量重设计 / 14 层</h3><p>角色发型、脸、服装、耳机、机体与 HUD 可分别编辑。不是 PNG 的逐线转换。</p><a href="svg/theme-vector-layered.svg" download>下载主题分层 SVG</a></div></div></section>
<section class="section"><h2>03 / 色彩系统</h2><div class="palette">'''
for name in ['bg','panel','violet','cyan','lime','pink','orange']:
    page+=f'<div><div class="swatch" style="background:{P[name]}"></div><div class="swatch-label">{name.upper()}<br>{P[name]}</div></div>'
page+='''</div></section><section id="layers" class="section"><h2>04 / 真正可切换的 UI 图层</h2><p>12 个具名图层。以下复选框可直接开关；原生矢量内容和单个位图插画层明确分开。</p><div class="button-row"><button id="all-on">全部显示</button><button id="only-ui">隐藏插画</button><button id="only-art">只看插画</button><span id="layer-note">12 / 12 层显示</span></div><div class="stage" id="layer-stage">'''+inline_ui+'</div><div class="layer-controls">'+layer_checkboxes+'''</div><div class="note">完整 AI 插画是一个嵌入 PNG 图层。另有不含位图的纯矢量主题与全矢量 UI。所有分层均使用 Inkscape 图层标记，并附独立导出的同画布 SVG。</div></section>
<section id="icons" class="section"><h2>05 / 全套图标</h2><p>72 个 UI 图标与现有文件名逐一对应，另有 6 个品牌图标。24px 网格、1.65px 折角线条；点击单图可下载。</p><div class="actions"><a href="svg/icon-contact-sheet.svg" download>SVG 图标总览</a><a href="icons/sprite.svg" download>77-symbol Sprite</a><a href="theme/tokens.json" download>配色 JSON</a><a href="theme/sikeoop-eva-miku.css" download>可选主题 CSS</a></div><div class="icons" style="margin-top:24px">'''+gallery+'''</div></section><footer>交付：设计效果图、原生分层 SVG、兼容图标、配色与编辑器/终端主题文件。尚未写入或启用桌面应用。</footer></div><script>
const stage=document.querySelector('#layer-stage');const inputs=[...document.querySelectorAll('[data-layer]')];function update(){for(const i of inputs)stage.querySelector('#'+i.dataset.layer).style.display=i.checked?'':'none';document.querySelector('#layer-note').textContent=inputs.filter(x=>x.checked).length+' / '+inputs.length+' 层显示';}inputs.forEach(i=>i.addEventListener('change',update));document.querySelector('#all-on').onclick=()=>{inputs.forEach(i=>i.checked=true);update();};document.querySelector('#only-ui').onclick=()=>{inputs.forEach(i=>i.checked=i.dataset.layer!=='wallpaper-raster');update();};document.querySelector('#only-art').onclick=()=>{inputs.forEach(i=>i.checked=['window-background','wallpaper-raster'].includes(i.dataset.layer));update();};update();
</script></body></html>'''
page=page.replace('.icon-card img{width:36px;height:36px}', '.icon-card img,.icon-card svg{width:36px;height:36px;flex:none}.icon-card svg{color:#5CE1E6}')
write('index.html',page)
print(json.dumps({'ui_icons':len(D),'brand_icons':len(brand_bodies)+1,'ui_layers':len(ui_layers),'vector_theme_layers':len(theme_layers),'vector_ui_layers':len(vector_ui_layers),'layer_exports':len(ui_layers)+len(theme_layers)+len(vector_ui_layers)},ensure_ascii=False))
