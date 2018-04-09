#!/usr/bin/env python

import requests
import json
import sys
import click
from pprint import pprint as pp

@click.command()
@click.argument('url', nargs=1)
@click.argument('filename', nargs=-1)
def main(url, filename):
    jar = requests.cookies.RequestsCookieJar()
    for fn in filename:
        print('uploading {}'.format(fn))
        with open(fn, 'rb') as f:
            content = f.read()
            data = ('data:image/png;base64,' + content.encode('base64')).replace('\n', '')
            res = requests.post(url, json={'filename': fn, 'data': data}, cookies=jar)
            jar = res.cookies
            pp(res)
            pp(res.content)
    print('animating!')
    res = requests.post(url.replace('upload', 'merge'), cookies=jar)
    pp(res)
    pp(res.content)

if __name__ == '__main__':
    main()
