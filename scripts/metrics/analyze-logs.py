#!/usr/bin/env python3
"""
CloudFront log analyzer for Riftfound metrics.

Usage:
    python analyze-logs.py [--days N] [--format json|table] [--output FILE]

Examples:
    python analyze-logs.py                    # Last 30 days, table format
    python analyze-logs.py --days 7           # Last 7 days
    python analyze-logs.py --format json      # Output as JSON
    python analyze-logs.py --output report.json --format json
"""

import argparse
import gzip
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

# CloudFront log fields (tab-separated)
FIELDS = [
    'date', 'time', 'edge_location', 'bytes', 'client_ip', 'method', 'host',
    'uri_stem', 'status', 'referer', 'user_agent', 'query_string', 'cookie',
    'edge_result_type', 'request_id', 'host_header', 'protocol', 'cs_bytes',
    'time_taken', 'forwarded_for', 'ssl_protocol', 'ssl_cipher',
    'edge_response_result_type', 'protocol_version', 'fle_status',
    'fle_encrypted_fields', 'c_port', 'time_to_first_byte',
    'edge_detailed_result_type', 'content_type', 'content_len',
    'range_start', 'range_end'
]


def parse_log_line(line: str) -> dict | None:
    """Parse a CloudFront log line into a dict."""
    if line.startswith('#'):
        return None
    parts = line.strip().split('\t')
    if len(parts) < 10:
        return None
    return {FIELDS[i]: parts[i] if i < len(parts) else '' for i in range(len(FIELDS))}


def get_visitor_id(record: dict) -> str:
    """Extract metricId from cookie, fall back to IP.

    The frontend sets a 'mid' cookie with a persistent UUID to track
    visitors across IP changes (e.g., mobile users switching networks).
    """
    cookie = record.get('cookie', '')
    match = re.search(r'mid=([a-f0-9-]+)', cookie)
    return match.group(1) if match else record['client_ip']


def load_logs(logs_dir: Path, days: int | None = None) -> list[dict]:
    """Load all log files from the logs directory."""
    records = []
    cutoff_date = None
    if days:
        cutoff_date = (datetime.now() - timedelta(days=days)).strftime('%Y-%m-%d')

    for log_file in logs_dir.glob('*'):
        if log_file.suffix == '.gz':
            opener = gzip.open
        elif log_file.is_file() and not log_file.name.startswith('.'):
            opener = open
        else:
            continue

        try:
            with opener(log_file, 'rt', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    record = parse_log_line(line)
                    if record:
                        if cutoff_date and record['date'] < cutoff_date:
                            continue
                        records.append(record)
        except Exception as e:
            print(f"Warning: Could not read {log_file}: {e}", file=sys.stderr)

    return records


def analyze_logs(records: list[dict]) -> dict:
    """Analyze log records and return metrics."""
    if not records:
        return {'error': 'No log records found'}

    # Basic counts
    total_requests = len(records)
    unique_visitors = set(get_visitor_id(r) for r in records)
    successful = [r for r in records if r['status'].startswith(('2', '3'))]

    # Page views
    homepage = [r for r in records if r['uri_stem'] in ('/', '/index.html')]
    homepage_visitors = set(get_visitor_id(r) for r in homepage)

    # Event detail pages (pattern: /event/UUID or /events/UUID)
    event_pattern = re.compile(r'^/events?/[a-f0-9-]+$')
    event_pages = [r for r in records if event_pattern.match(r['uri_stem'])]
    event_page_visitors = set(get_visitor_id(r) for r in event_pages)
    unique_events = set(r['uri_stem'] for r in event_pages)

    # API usage
    api_calls = [r for r in records if r['uri_stem'].startswith('/api/')]
    calendar_api = [r for r in api_calls if r['uri_stem'] == '/api/events']
    geocode_api = [r for r in api_calls if r['uri_stem'].startswith('/api/events/geocode')]

    # Visit clicks (if tracking endpoint exists)
    visit_pattern = re.compile(r'/(visit|register)$')
    visit_clicks = [r for r in records if visit_pattern.search(r['uri_stem'])]
    visit_click_visitors = set(get_visitor_id(r) for r in visit_clicks)

    # Traffic by day
    daily_traffic = defaultdict(lambda: {'requests': 0, 'visitors': set()})
    for r in records:
        daily_traffic[r['date']]['requests'] += 1
        daily_traffic[r['date']]['visitors'].add(get_visitor_id(r))

    daily_stats = {
        date: {'requests': data['requests'], 'unique_visitors': len(data['visitors'])}
        for date, data in sorted(daily_traffic.items())
    }

    # Top pages
    page_counts = defaultdict(int)
    for r in records:
        page_counts[r['uri_stem']] += 1
    top_pages = sorted(page_counts.items(), key=lambda x: -x[1])[:15]

    # Top edge locations
    edge_counts = defaultdict(int)
    for r in records:
        edge_counts[r['edge_location']] += 1
    top_edges = sorted(edge_counts.items(), key=lambda x: -x[1])[:10]

    # User agents (browsers)
    browser_counts = defaultdict(int)
    for r in records:
        ua = r['user_agent']
        if 'Chrome' in ua:
            browser = 'Chrome'
        elif 'Firefox' in ua:
            browser = 'Firefox'
        elif 'Safari' in ua and 'Chrome' not in ua:
            browser = 'Safari'
        elif 'Edge' in ua:
            browser = 'Edge'
        elif 'bot' in ua.lower() or 'crawler' in ua.lower():
            browser = 'Bot'
        else:
            browser = 'Other'
        browser_counts[browser] += 1
    browsers = dict(sorted(browser_counts.items(), key=lambda x: -x[1]))

    return {
        'summary': {
            'total_requests': total_requests,
            'unique_visitors': len(unique_visitors),
            'successful_requests': len(successful),
            'date_range': {
                'start': min(r['date'] for r in records),
                'end': max(r['date'] for r in records),
            }
        },
        'page_views': {
            'homepage': {'total': len(homepage), 'unique': len(homepage_visitors)},
            'event_details': {'total': len(event_pages), 'unique': len(event_page_visitors)},
            'unique_events_viewed': len(unique_events),
        },
        'api_usage': {
            'total_api_calls': len(api_calls),
            'calendar_requests': len(calendar_api),
            'location_searches': len(geocode_api),
        },
        'external_clicks': {
            'visit_store_clicks': {'total': len(visit_clicks), 'unique': len(visit_click_visitors)},
            'note': 'Requires /visit tracking endpoint' if not visit_clicks else None,
        },
        'daily_stats': daily_stats,
        'top_pages': [{'path': p, 'count': c} for p, c in top_pages],
        'top_edge_locations': [{'location': loc, 'count': c} for loc, c in top_edges],
        'browsers': browsers,
    }


def format_table(metrics: dict) -> str:
    """Format metrics as a readable table."""
    lines = []
    lines.append('=' * 50)
    lines.append('RIFTFOUND METRICS REPORT')
    lines.append('=' * 50)

    s = metrics['summary']
    lines.append('')
    lines.append(f"Date range: {s['date_range']['start']} to {s['date_range']['end']}")
    lines.append('')
    lines.append('TRAFFIC OVERVIEW')
    lines.append('-' * 40)
    lines.append(f"Total requests:      {s['total_requests']:,}")
    lines.append(f"Unique visitors:     {s['unique_visitors']:,}")
    lines.append(f"Successful requests: {s['successful_requests']:,}")

    pv = metrics['page_views']
    lines.append('')
    lines.append('PAGE VIEWS')
    lines.append('-' * 40)
    lines.append(f"Homepage:            {pv['homepage']['total']:,} ({pv['homepage']['unique']:,} unique)")
    lines.append(f"Event details:       {pv['event_details']['total']:,} ({pv['event_details']['unique']:,} unique)")
    lines.append(f"Unique events viewed: {pv['unique_events_viewed']:,}")

    api = metrics['api_usage']
    lines.append('')
    lines.append('API USAGE')
    lines.append('-' * 40)
    lines.append(f"Total API calls:     {api['total_api_calls']:,}")
    lines.append(f"Calendar requests:   {api['calendar_requests']:,}")
    lines.append(f"Location searches:   {api['location_searches']:,}")

    ec = metrics['external_clicks']
    lines.append('')
    lines.append('EXTERNAL CLICKS')
    lines.append('-' * 40)
    if ec['note']:
        lines.append(f"Visit store clicks: {ec['note']}")
    else:
        lines.append(f"Visit store clicks: {ec['visit_store_clicks']['total']:,} ({ec['visit_store_clicks']['unique']:,} unique)")

    lines.append('')
    lines.append('TOP PAGES')
    lines.append('-' * 40)
    for p in metrics['top_pages'][:10]:
        lines.append(f"{p['count']:>8}  {p['path']}")

    lines.append('')
    lines.append('DAILY TRAFFIC')
    lines.append('-' * 40)
    for date, stats in list(metrics['daily_stats'].items())[-14:]:
        lines.append(f"{date}: {stats['requests']:>6} requests, {stats['unique_visitors']:>5} unique")

    lines.append('')
    lines.append('BROWSERS')
    lines.append('-' * 40)
    for browser, count in metrics['browsers'].items():
        pct = count / s['total_requests'] * 100
        lines.append(f"{browser:>10}: {count:>8} ({pct:.1f}%)")

    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='Analyze CloudFront logs')
    parser.add_argument('--days', type=int, default=30, help='Number of days to analyze')
    parser.add_argument('--format', choices=['json', 'table'], default='table', help='Output format')
    parser.add_argument('--output', '-o', help='Output file (default: stdout)')
    args = parser.parse_args()

    logs_dir = Path(__file__).parent / 'logs'
    if not logs_dir.exists():
        print("No logs directory found. Run ./download-logs.sh first.", file=sys.stderr)
        sys.exit(1)

    print(f"Loading logs from {logs_dir}...", file=sys.stderr)
    records = load_logs(logs_dir, args.days)
    print(f"Loaded {len(records)} records", file=sys.stderr)

    metrics = analyze_logs(records)

    if args.format == 'json':
        output = json.dumps(metrics, indent=2, default=str)
    else:
        output = format_table(metrics)

    if args.output:
        Path(args.output).write_text(output)
        print(f"Report written to {args.output}", file=sys.stderr)
    else:
        print(output)


if __name__ == '__main__':
    main()
