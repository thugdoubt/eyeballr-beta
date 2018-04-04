#!/usr/bin/env python

import requests
import json
import sys
import click
from pprint import pprint as pp

@click.command()
@click.argument('filename')
@click.argument('url')
def main(filename, url):
    with open(filename, 'rb') as f:
        content = f.read()
        data = ('data:image/png;base64,' + content.encode('base64')).replace('\n', '')
        jar = requests.cookies.RequestsCookieJar()
        jar.set('UID', '70ac51ed-d34d-417e-887c-64cd1edd3c42')
        res = requests.post(url, json={'filename': filename, 'data': data}, cookies=jar)
        pp(res)
        pp(res.content)

if __name__ == '__main__':
    main()
