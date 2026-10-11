#!/usr/bin/env python3
"""Convert the concept image's illustrated header to actual SVG color paths."""
from pathlib import Path
import argparse
import tempfile
import xml.etree.ElementTree as ET
from PIL import Image
import vtracer

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--source',type=Path,default=ROOT.parent/'sikeoop-eva-miku-update-card-v1/auto-update-card.png')
p.add_argument('--output',type=Path,default=ROOT/'illustrations/hero-eva-miku-paths.svg')
args=p.parse_args()
args.output.parent.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='sikeoop-svg-trace-') as tmp:
    crop=Path(tmp)/'header.png'
    with Image.open(args.source) as im:
        if im.size!=(1536,1024):raise ValueError('Reference must be the delivered 1536×1024 update-card concept.')
        im.crop((650,114,1446,428)).save(crop)
    vtracer.convert_image_to_svg_py(str(crop),str(args.output),colormode='color',hierarchical='stacked',mode='spline',filter_speckle=1,color_precision=8,layer_difference=4,corner_threshold=60,length_threshold=3.5,max_iterations=10,splice_threshold=45,path_precision=2)
ns='http://www.w3.org/2000/svg';ET.register_namespace('',ns)
root=ET.parse(args.output).getroot();root.set('viewBox','0 0 796 314');root.set('width','796');root.set('height','314')
root.insert(0,ET.Element('{'+ns+'}title'));root[0].text='EVA × Miku / automatically traced color paths'
root.insert(1,ET.Element('{'+ns+'}desc'));root[1].text='Color-path approximation of the illustrated header. Not an embedded PNG; not hand-separated semantic character parts.'
for i,el in enumerate(root.findall('.//{'+ns+'}path')):el.set('id',f'hero-path-{i:05d}')
args.output.write_text(ET.tostring(root,encoding='unicode'))
print({'svg':str(args.output),'paths':len(root.findall('.//{'+ns+'}path')),'bytes':args.output.stat().st_size})
