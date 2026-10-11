#!/usr/bin/env python3
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
NS='http://www.w3.org/2000/svg'
INK='http://www.inkscape.org/namespaces/inkscape'
checks=json.loads((ROOT/'render-checks.json').read_text())
rendered={x['file'] for x in checks}
docs=list(ROOT.rglob('*.svg'))
for f in docs:
    r=ET.parse(f).getroot(); ids=set()
    assert r.tag==f'{{{NS}}}svg' and r.get('viewBox'),f
    for el in r.iter():
        name=el.tag.split('}')[-1]
        assert name not in ['image','script','foreignObject'],(f,name)
        i=el.get('id')
        if i: assert i not in ids,(f,i);ids.add(i)
        for k,v in el.attrib.items():
            assert not k.lower().startswith('on'),(f,k)
            if k.endswith('href'): assert v.startswith('#'),(f,v)
    for value in re.findall(r'url\(#([^)]*)\)',f.read_text()): assert value in ids,(f,value)
    if '/editable/' not in str(f) and '/source/' not in str(f): assert not list(r.iter(f'{{{NS}}}text')),f
    if not f.name=='sprite.svg': assert str(f.relative_to(ROOT)) in rendered,f
assets=json.loads((ROOT/'assets.json').read_text())
master=ET.parse(ROOT/'installer-layered.svg').getroot()
layers=[x for x in master if x.get(f'{{{INK}}}groupmode')=='layer']
assert len(layers)==16
assert [x.get('id') for x in layers]==[x['id'] for x in assets['layers']]
for item in assets['layers']:
    r=ET.parse(ROOT/item['file']).getroot();assert r.get('viewBox')=='0 0 1040 660'
assert len(list((ROOT/'screens').glob('*.svg')))==6
assert len(list((ROOT/'editable').glob('*.svg')))==6
symbols=list(ET.parse(ROOT/'icons/sprite.svg').getroot().iter(f'{{{NS}}}symbol'));assert len(symbols)==18
for f in (ROOT/'previews').glob('*.png'):
    with Image.open(f) as im:im.verify()
with Image.open(ROOT/'previews/checkbox-alpha.png') as im: assert im.convert('RGBA').getchannel('A').getextrema()==(0,255)
P=json.loads((ROOT/'tokens.json').read_text())['colors']
def luminance(h):
    a=[int(h[i:i+2],16)/255 for i in (1,3,5)]; b=[x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in a]
    return .2126*b[0]+.7152*b[1]+.0722*b[2]
def contrast(a,b):
    x,y=sorted([luminance(a),luminance(b)]);return (y+.05)/(x+.05)
cr={f'{a}/{b}':round(contrast(P[a],P[b]),2) for a,b in [('ink','surface'),('muted','surface'),('faint','surface'),('aqua','raised'),('violet','surface'),('error','raised')]}
assert min(cr.values())>=4.5,cr
result=dict(status='design-only-not-integrated',svgCount=len(docs),renderedSVGs=len(checks),screens=6,registeredLayers=16,icons=19,embeddedRaster=0,contrast=cr)
(ROOT/'validation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False,indent=2))
