#!/usr/bin/env python3
"""Validate pure-vector files, references, glyph outlines and registered layers."""
from pathlib import Path
import hashlib
import json
import re
import xml.etree.ElementTree as ET
from PIL import Image

R=Path(__file__).resolve().parents[1]
NS='http://www.w3.org/2000/svg';INK='http://www.inkscape.org/namespaces/inkscape'
files=sorted(R.rglob('*.svg'));assert len(files)==90
assert len(list((R/'icons').glob('*.svg')))==22
assert len(list((R/'layers').glob('*.svg')))==14
assert len(list((R/'states').glob('*.svg')))==5
assets=json.loads((R/'assets.json').read_text())
for a in assets['assets']:assert (R/a['file']).is_file()
for p in files:
    root=ET.parse(p).getroot()
    assert root.tag=='{'+NS+'}svg'
    assert not root.findall('.//{'+NS+'}image'),f'Raster in {p}'
    assert not root.findall('.//{'+NS+'}script'),f'Script in SVG: {p}'
    assert not root.findall('.//{'+NS+'}foreignObject'),f'Foreign content: {p}'
    ids=[x.get('id') for x in root.iter() if x.get('id')]
    assert len(ids)==len(set(ids)),f'Duplicate ID in {p}'
    for el in root.iter():
        for name,value in el.attrib.items():
            assert not name.split('}')[-1].lower().startswith('on'),f'Event handler in SVG: {p}'
            if name.split('}')[-1] in ['href','src']:assert value.startswith('#'),f'External reference: {p}'
            for target in re.findall(r'url\(#([^\)]+)\)',value):assert target in ids,f'Missing definition {target} in {p}'
    if p.name!='auto-update-card-editable.svg':assert not root.findall('.//{'+NS+'}text'),f'Unoutlined glyphs: {p}'
    if p.parent.name=='layers':assert root.get('viewBox')=='0 0 1360 912'
ready=ET.parse(R/'auto-update-card.svg').getroot()
layers=[x for x in ready if x.get('{'+INK+'}groupmode')=='layer']
assert [x.get('id') for x in layers]==[x['id'] for x in assets['layers']]
assert len(layers)==14
traced=ET.parse(R/'illustrations/hero-eva-miku-paths.svg').getroot()
traced_paths=len(traced.findall('.//{'+NS+'}path'));assert traced_paths>1000
sprite=ET.parse(R/'icons/sprite.svg').getroot();assert len(sprite.findall('{'+NS+'}symbol'))==21
render_checks=json.loads((R/'render-checks.json').read_text());assert len(render_checks)==89
assert all(x['status']=='rendered' and x['thumbnailBytes']>0 for x in render_checks)
pngs=[]
for p in (R/'previews').glob('*.png'):
    with Image.open(p) as im:
        im.verify()
    with Image.open(p) as im:
        a=im.getchannel('A').getextrema() if 'A' in im.getbands() else None
        pngs.append(dict(file=str(p.relative_to(R)),width=im.width,height=im.height,alphaExtrema=a))
        if p.name in ['toggle-off.png','button-primary-normal.png']:assert a and a[0]==0 and a[1]==255
manifest=dict(theme='sikeoop EVA × MIKU automatic-update card',status='design-assets-not-applied',svgCount=len(files),embeddedRasterImages=0,icons=21,states=5,registeredLayers=14,illustrationTracePaths=traced_paths,renderedSVGs=89,previews=pngs,files=[])
for p in sorted(R.rglob('*')):
    if p.is_file() and p.name!='manifest.json' and '__pycache__' not in p.parts:
        manifest['files'].append(dict(path=str(p.relative_to(R)),bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()))
(R/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in manifest.items() if k not in ['files','previews']},ensure_ascii=False,indent=2))
