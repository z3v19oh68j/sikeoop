#!/usr/bin/env python3
"""Validate delivered assets, icon compatibility, layers, hashes and contrast."""
from pathlib import Path
import base64
import hashlib
import json
import xml.etree.ElementTree as ET
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
NS={'s':'http://www.w3.org/2000/svg','i':'http://www.inkscape.org/namespaces/inkscape'}
tokens=json.loads((ROOT/'theme/tokens.json').read_text())
layer_contract=json.loads((ROOT/'layers.json').read_text())
ui_names={p.stem for p in (ROOT/'icons/ui').glob('*.svg')}
assert ui_names==set(tokens['iconContract']['names'])
assert len(ui_names)==72
assert len(list((ROOT/'icons/brand').glob('*.svg')))==6
assert len(list((ROOT/'svg/layers').glob('*.svg')))==38

svg_checks=[]
for p in sorted(ROOT.rglob('*.svg')):
    tree=ET.parse(p)
    root=tree.getroot()
    ids=[e.get('id') for e in root.iter() if e.get('id')]
    assert len(ids)==len(set(ids)), f'Duplicate ids: {p}'
    assert not root.findall('.//s:script',NS), f'Script in SVG: {p}'
    for e in root.findall('.//s:image',NS):
        uri=e.get('href','')
        assert uri.startswith('data:image/png;base64,'),f'External image in {p}'
        data=base64.b64decode(uri.split(',',1)[1],validate=True)
        assert data==(ROOT/'images/theme-wallpaper.png').read_bytes()
    svg_checks.append(str(p.relative_to(ROOT)))

for kind,filename in [('ui','ui-skin-layered.svg'),('vectorUI','ui-skin-vector-only.svg'),('vectorTheme','theme-vector-layered.svg')]:
    tree=ET.parse(ROOT/'svg'/filename)
    roots=[e for e in tree.getroot() if e.get('{'+NS['i']+'}groupmode')=='layer']
    assert [e.get('id') for e in roots]==[e['id'] for e in layer_contract[kind]]
    for entry in layer_contract[kind]: assert (ROOT/entry['file']).is_file()
    if kind!='ui': assert not tree.getroot().findall('.//s:image',NS)

sprite=ET.parse(ROOT/'icons/sprite.svg').getroot()
assert len(sprite.findall('s:symbol',NS))==77
images=[]
for p in sorted(ROOT.rglob('*.png')):
    with Image.open(p) as im:
        im.verify()
    with Image.open(p) as im:
        info={'file':str(p.relative_to(ROOT)),'width':im.width,'height':im.height,'mode':im.mode}
        if 'A' in im.getbands():
            info['alphaExtrema']=list(im.getchannel('A').getextrema())
        if p.name=='app-icon-1024.png': assert im.size==(1024,1024) and im.getchannel('A').getextrema()[0]==0
        images.append(info)

with Image.open(ROOT/'icons/app/sikeoop-eva-miku.ico') as ico:
    ico_sizes=sorted(ico.ico.sizes())
    assert ico_sizes==[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]
with Image.open(ROOT/'icons/app/sikeoop-eva-miku.icns') as icns:
    assert icns.size==(1024,1024)
with Image.open(ROOT/'images/preview-browser.jpg') as proof:
    proof.verify()

def luminance(color):
    cs=[int(color[i:i+2],16)/255 for i in [1,3,5]]
    cs=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in cs]
    return .2126*cs[0]+.7152*cs[1]+.0722*cs[2]

def contrast(a,b):
    l1,l2=sorted([luminance(a),luminance(b)])
    return (l2+.05)/(l1+.05)

palette=tokens['palette']
contrasts=[]
for fg,bg in [('ink','panel'),('ink2','panel'),('muted','panel'),('faint','panel'),('cyan','panel'),('violet','panel'),('lime','panel'),('pink','panel'),('orange','panel'),('cyan','raised'),('ink2','selected')]:
    ratio=contrast(palette[fg],palette[bg])
    assert ratio>=4.5,f'Contrast below 4.5: {fg}/{bg} {ratio}'
    contrasts.append({'foreground':fg,'background':bg,'ratio':round(ratio,2)})

for p in (ROOT/'theme').glob('*.json'): json.loads(p.read_text())
html_source=(ROOT/'index.html').read_text()
assert len(ET.fromstring((ROOT/'svg/ui-skin-layered.svg').read_text()).findall('s:g',NS))==12
assert 'data-layer="wallpaper-raster"' in html_source
assert len(ui_names)==tokens['iconContract']['sourceCount']
manifest={'theme':tokens['name'],'state':'design-assets-not-applied','generator':'built-in image_gen for two raster concepts; native code for SVG assets','icons':{'ui':72,'brand':6,'spriteSymbols':77,'icoSizes':ico_sizes,'icnsMaxSize':[1024,1024]},'layers':{'ui':12,'vectorUI':12,'vectorTheme':14,'independentExports':38},'pngs':images,'contrastChecks':contrasts,'svgXMLValidated':len(svg_checks),'files':[]}
for p in sorted(ROOT.rglob('*')):
    if p.is_file() and p.name not in ['manifest.json'] and '__pycache__' not in p.parts:
        manifest['files'].append({'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in manifest.items() if k!='files'},ensure_ascii=False,indent=2))
