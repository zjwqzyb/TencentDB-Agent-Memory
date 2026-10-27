#!/usr/bin/env python3
"""JSON CLI for MemoryPanel's internal issue tracker (Python standard library only)."""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def call(action, payload):
    required = ('MEMORY_PANEL_URL', 'MEMORY_SERVICE_ID', 'MEMORY_USER_KEY')
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        raise ValueError('Missing environment variables: ' + ', '.join(missing))
    url = os.environ['MEMORY_PANEL_URL'].rstrip('/') + '/api/v1/meta/issue/' + action
    request = Request(url, data=json.dumps(payload).encode(), method='POST', headers={
        'Content-Type': 'application/json',
        'X-Tdai-Service-Id': os.environ['MEMORY_SERVICE_ID'],
        'X-Tdai-User-Key': os.environ['MEMORY_USER_KEY'],
    })
    try:
        with urlopen(request, timeout=30) as response:
            envelope = json.load(response)
    except HTTPError as exc:
        try:
            detail = json.load(exc).get('message', '')
        except (ValueError, AttributeError):
            detail = ''
        raise ValueError(f'Issue API returned HTTP {exc.code}: {detail}') from None
    except URLError:
        raise ValueError('Cannot reach the configured MemoryPanel URL') from None
    if envelope.get('code') != 0:
        raise ValueError(f"Issue API {envelope.get('code')}: {envelope.get('message', 'Unknown error')}")
    return envelope.get('data')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    listing = sub.add_parser('list')
    listing.add_argument('--team', default=os.environ.get('MEMORY_TEAM_ID'))
    listing.add_argument('--query')
    listing.add_argument('--state', choices=['open', 'closed'])
    listing.add_argument('--stage')
    listing.add_argument('--triage')
    listing.add_argument('--label')
    listing.add_argument('--parent-id')
    listing.add_argument('--ready', action='store_true', default=None)
    listing.add_argument('--all', action='store_true', help='Fetch all pages')
    listing.add_argument('--offset', type=int, default=0)
    listing.add_argument('--limit', type=int, default=20)
    get = sub.add_parser('get'); get.add_argument('id')
    create = sub.add_parser('create')
    create.add_argument('--team', default=os.environ.get('MEMORY_TEAM_ID'))
    create.add_argument('--file', required=True, help='JSON body file, or - for stdin')
    update = sub.add_parser('update'); update.add_argument('id')
    update.add_argument('--revision', type=int, required=True)
    update.add_argument('--file', required=True, help='JSON patch file, or - for stdin')
    comment = sub.add_parser('comment'); comment.add_argument('id')
    comment.add_argument('--revision', type=int, required=True)
    comment.add_argument('--body-file', required=True, help='Markdown file, or - for stdin')
    args = parser.parse_args()
    if args.action == 'list':
        if not args.team: parser.error('--team or MEMORY_TEAM_ID is required')
        if not 1 <= args.limit <= 100 or args.offset < 0: parser.error('limit must be 1..100; offset must be nonnegative')
        payload = {key: getattr(args, key) for key in ('query', 'state', 'stage', 'triage', 'label', 'parent_id', 'ready', 'offset', 'limit') if getattr(args, key) is not None}
        payload['team_id'] = args.team
    elif args.action in ('create', 'update'):
        payload = json.loads(sys.stdin.read() if args.file == '-' else Path(args.file).read_text())
        if not isinstance(payload, dict): parser.error('JSON body must be an object')
        if args.action == 'create':
            if not args.team: parser.error('--team or MEMORY_TEAM_ID is required')
            payload['team_id'] = args.team
        else:
            payload.update(task_id=args.id, expected_revision=args.revision)
    else:
        payload = {'task_id': args.id}
        if args.action == 'comment':
            payload.update(expected_revision=args.revision, body=sys.stdin.read() if args.body_file == '-' else Path(args.body_file).read_text())
    result = call(args.action, payload)
    if args.action == 'list' and args.all:
        items = list(result['items'])
        while payload['offset'] + len(result['items']) < result['total'] and result['items']:
            payload['offset'] += len(result['items'])
            result = call('list', payload)
            items.extend(result['items'])
        result = {'items': items, 'total': len(items)}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
