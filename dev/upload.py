#!/usr/bin/env python

import requests
import json
import sys
import click
from time import sleep
from pprint import pprint as pp

@click.command()
@click.argument('baseurl', nargs=1)
@click.argument('filename', nargs=-1)
def main(baseurl, filename):
    jar = requests.cookies.RequestsCookieJar()

    # get ticket
    url = '{}/api/v0/ticket'.format(baseurl)
    res = requests.get(url, cookies=jar)
    jar = res.cookies
    ticket = res.json()['ticket']

    # upload files
    url = '{}/api/v0/upload/{}'.format(baseurl, ticket)
    for fn in filename:
        print('uploading {}'.format(fn))
        with open(fn, 'rb') as f:
            content = f.read()
            data = ('data:image/png;base64,' + content.encode('base64')).replace('\n', '')
            res = requests.post(url, json={'filename': fn, 'data': data}, cookies=jar)
            pp(res.content)

    # wait for files to be pre-processed
    ready = False
    url = '{}/api/v0/ready/{}'.format(baseurl, ticket)
    while (ready is False):
        print('waiting..')
        res = requests.get(url, cookies=jar)
        pp(res.json())
        ready = res.json().get('ready', False)
        sleep(2)

    # animate
    print('animating!')
    url = '{}/api/v0/merge/{}'.format(baseurl, ticket)
    res = requests.post(url, cookies=jar)
    pp(res)
    pp(res.content)

    # wait for animation to be complete
    complete = False
    count = 0
    url = '{}/api/v0/complete/{}'.format(baseurl, ticket)
    while (complete is False and count < 20):
        print('waiting..')
        res = requests.get(url, cookies=jar)
        pp(res.json())
        complete = res.json().get('complete', False)
        count += 1
        sleep(2)

    print('done!!!')

if __name__ == '__main__':
    main()
