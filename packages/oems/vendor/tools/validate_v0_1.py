"""Offline structural, semantic and calculation checks for the OEMS draft.

This small verification helper is not a production collector or certification
service. The language-neutral specification remains the normative contract.
"""
from __future__ import annotations

import copy
import json
import statistics
from datetime import datetime, timedelta
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / 'schemas' / 'v0.1'
KINDS = {'services': 'service', 'changes': 'change',
         'deployments': 'deployment', 'incidents': 'incident'}


class SemanticError(ValueError):
    def __init__(self, code, detail):
        self.code = code
        super().__init__(f'{code}: {detail}')


def require(condition, code, detail):
    if not condition:
        raise SemanticError(code, detail)


def instant(value):
    return datetime.fromisoformat(value.upper().replace('Z', '+00:00'))


def read(path):
    return json.loads(path.read_text())


def validators():
    checker = FormatChecker()
    for required_format in ('date-time', 'uri'):
        if required_format not in checker.checkers:
            raise RuntimeError(f'Missing {required_format} checker; install requirements-dev.txt')
    registry = Registry()
    documents = {}
    for path in sorted(SCHEMAS.glob('*.schema.json')):
        document = read(path)
        Draft202012Validator.check_schema(document)
        documents[path.stem.removesuffix('.schema')] = (path, document)
        registry = registry.with_resource(path.as_uri(), Resource.from_contents(document))
    # Only preloaded local schemas are available; no remote retrieval is configured.
    return {kind: Draft202012Validator(
        {'$ref': path.as_uri()}, registry=registry, format_checker=checker
    ) for kind, (path, _) in documents.items()}


def normalise(dataset):
    """Run semantics after structural validation; return deduplicated records."""
    data = copy.deepcopy(dataset)
    window = data['window']
    start, end, cutoff = map(instant, (window['start'], window['end'], data['evidence_cutoff']))
    require(start < end, 'invalid_window', 'start must precede end')
    require(all(t.utcoffset() == timedelta(0) and t.time().isoformat() == '00:00:00'
                for t in (start, end)), 'unsupported_calendar', 'UTC midnight boundaries required')
    require(window['calendar_days'] == (end - start).days,
            'calendar_days_mismatch', 'calendar_days must match boundaries')
    require(cutoff >= end, 'cutoff_before_window_end', 'reporting window must be closed at cutoff')
    seen_ids = set()
    for plural in KINDS:
        by_id = {}
        for record in data[plural]:
            rid = record['id']
            if rid in by_id:
                require(record == by_id[rid], 'conflicting_id', rid)
                continue
            require(rid not in seen_ids, 'cross_kind_id', rid)
            by_id[rid] = record
            seen_ids.add(rid)
            observed = instant(record['observed_at'])
            require(observed <= cutoff, 'evidence_after_cutoff', rid)
            for field in ('committed_at', 'effective_at', 'failure_started_at', 'restored_at'):
                if record.get(field) is not None:
                    require(instant(record[field]) <= observed,
                            'event_after_observation', f'{rid}/{field}')
        data[plural] = list(by_id.values())
    services = {r['id'] for r in data['services']}
    changes = {r['id']: r for r in data['changes']}
    keys = set()
    for change in changes.values():
        key = (change['repository_id'], change['commit_id'])
        require(key not in keys, 'change_alias', repr(key))
        keys.add(key)
    rollout_keys = set()
    for deployment in data['deployments']:
        rid = deployment['id']
        require(deployment['service_id'] in services, 'missing_service', rid)
        key = (deployment['service_id'], deployment['rollout_group_id'])
        require(key not in rollout_keys, 'rollout_alias', repr(key))
        rollout_keys.add(key)
        qualification = deployment['qualification']
        if qualification == 'qualifying':
            require(deployment['environment'] == 'production' and deployment['effective_at'] is not None,
                    'invalid_qualification', rid)
        if qualification == 'excluded':
            require(deployment['effective_at'] is None, 'excluded_effective_time', rid)
        scope = deployment['qualification_window']
        require(qualification == 'unknown' or scope is None, 'unexpected_qualification_window', rid)
        if scope is not None:
            require(instant(scope['start']) < instant(scope['end']), 'invalid_qualification_window', rid)
            if deployment['effective_at'] is not None:
                require(instant(scope['start']) <= instant(deployment['effective_at']) < instant(scope['end']),
                        'qualification_time_outside_scope', rid)
        require(deployment['failure'] != 'failed' or qualification == 'qualifying',
                'failure_without_qualification', rid)
        if qualification == 'qualifying':
            for cid in deployment['change_ids']:
                if cid in changes:
                    require(instant(changes[cid]['committed_at']) <= instant(deployment['effective_at']),
                            'negative_lead_time', f'{rid}/{cid}')
    deployments = {r['id']: r for r in data['deployments']}
    for episode in data['incidents']:
        rid = episode['id']
        require(episode['service_id'] in services, 'missing_service', rid)
        if episode['restored_at'] is not None:
            require(instant(episode['restored_at']) >= instant(episode['failure_started_at']),
                    'negative_recovery_time', rid)
        causal = deployments.get(episode['causal_deployment_id'])
        if causal is None:
            continue  # Disclosed unresolved evidence, not an arbitrary join.
        require(causal['service_id'] == episode['service_id'], 'cross_service_causality', rid)
        require(causal['qualification'] != 'excluded', 'excluded_causal_deployment', rid)
        require(causal['failure'] != 'no_recorded_failure', 'contradictory_causal_classification', rid)
        if causal['effective_at'] is not None:
            require(instant(episode['failure_started_at']) >= instant(causal['effective_at']),
                    'onset_before_deployment', rid)
            if episode['start_is_approximate']:
                require(instant(episode['failure_started_at']) == instant(causal['effective_at']),
                        'invalid_approximation', rid)
    return data


def quality(reasons, count, zero_is_complete=False):
    reasons = sorted(set(reasons))
    status = 'provisional' if reasons else 'complete' if count or zero_is_complete else 'no_observations'
    return {'status': status, 'quality_reasons': reasons}


def median(values):
    return statistics.median(values) if values else None


def affects(deployment, start, end):
    """Unknown qualification uses declared coverage, then time, then unbounded scope."""
    scope = deployment['qualification_window']
    if scope is not None:
        return instant(scope['start']) < end and instant(scope['end']) > start
    if deployment['effective_at'] is not None:
        return start <= instant(deployment['effective_at']) < end
    return True


def calculate(data, service_id):
    window = data['window']
    start, end = instant(window['start']), instant(window['end'])
    deployments = [r for r in data['deployments'] if r['service_id'] == service_id]
    qualifying = [r for r in deployments if r['qualification'] == 'qualifying']
    population = [r for r in qualifying if start <= instant(r['effective_at']) < end]
    unknown = [r for r in deployments if r['qualification'] == 'unknown' and affects(r, start, end)]
    reasons = []
    if not data['collection_complete']:
        reasons.append('incomplete_collection')
    if unknown:
        reasons.append('unresolved_qualification')
    n = len(population)
    result = {key: copy.deepcopy(data[key]) for key in ('dataset_id', 'profile_version', 'window', 'evidence_cutoff')}
    result.update(service_id=service_id, qualification_unknown_count=len(unknown))
    result['deployment_frequency'] = {**quality(reasons, n, True), 'count': n,
                                      'deployments_per_day': None if reasons else n / window['calendar_days']}
    for metric, field, value, reason in (
        ('change_fail_rate', 'failure', 'failed', 'unknown_failure_classification'),
        ('deployment_rework_rate', 'rework', 'incident_driven', 'unknown_rework_classification')
    ):
        numerator = sum(r[field] == value for r in population)
        unresolved = sum(r[field] == 'unknown' for r in population)
        metric_reasons = reasons + ([reason] if unresolved else [])
        result[metric] = {**quality(metric_reasons, n), 'numerator': numerator, 'denominator': n,
                          'unknown_count': unresolved, 'lower_bound': numerator / n if n else None,
                          'upper_bound': (numerator + unresolved) / n if n else None,
                          'ratio': numerator / n if n and not metric_reasons else None,
                          'bounds_scope': 'observed_population' if reasons else 'full_population'}
    history = [r for r in qualifying if instant(r['effective_at']) < end]
    history_unknown = any(r['qualification'] == 'unknown' and affects(
        r, datetime.min.replace(tzinfo=start.tzinfo), end) for r in deployments)
    changes = {r['id']: r for r in data['changes']}
    missing = {cid for r in history for cid in r['change_ids'] if cid not in changes}
    linkage_unknown = sum(not r['change_links_complete'] for r in history)
    lead_reasons = list(reasons)
    if not data['deployment_history_complete'] or history_unknown:
        lead_reasons.append('incomplete_history')
    if missing:
        lead_reasons.append('unresolved_change_links')
    if linkage_unknown:
        lead_reasons.append('incomplete_change_linkage')
    durations = []
    for cid, change in changes.items():
        times = [instant(r['effective_at']) for r in history if cid in r['change_ids']]
        if times and start <= min(times) < end:
            durations.append((min(times) - instant(change['committed_at'])).total_seconds())
    # Missing links can hide a previous first deployment; retain only candidates.
    confirmed = not lead_reasons
    result['change_lead_time'] = {**quality(lead_reasons, len(durations)),
        'observation_count': len(durations) if confirmed else 0,
        'candidate_count': 0 if confirmed else len(durations),
        'unresolved_change_count': len(missing), 'linkage_unknown_count': linkage_unknown,
        'median_seconds': median(durations) if confirmed else None}
    by_id = {r['id']: r for r in deployments}
    episodes = [r for r in data['incidents'] if r['service_id'] == service_id and
                start <= instant(r['failure_started_at']) < end]
    completed, approximate = [], []
    open_count = approximate_count = unresolved_count = 0
    for episode in episodes:
        causal = by_id.get(episode['causal_deployment_id'])
        if causal is None or causal['qualification'] != 'qualifying' or causal['failure'] != 'failed':
            unresolved_count += 1
            continue
        approximate_count += int(episode['start_is_approximate'])
        if episode['restored_at'] is None:
            open_count += 1
        else:
            duration = (instant(episode['restored_at']) - instant(episode['failure_started_at'])).total_seconds()
            (approximate if episode['start_is_approximate'] else completed).append(duration)
    unknown_failures = sum(r['failure'] == 'unknown' for r in history)
    recovery_reasons = list(reasons)
    for condition, reason in (
        (not data['recovery_evidence_complete'], 'incomplete_recovery_evidence'),
        (unknown_failures, 'unknown_failure_classification'),
        (unresolved_count, 'unresolved_causal_links'),
        (open_count, 'open_recovery_episodes'),
        (approximate_count, 'approximate_recovery_start')
    ):
        if condition:
            recovery_reasons.append(reason)
    result['failed_deployment_recovery_time'] = {**quality(recovery_reasons, len(completed)),
        'observation_count': len(completed), 'open_count': open_count,
        'approximate_count': approximate_count, 'unresolved_count': unresolved_count,
        'unknown_failure_count': unknown_failures, 'median_seconds': median(completed),
        'approximate_median_seconds': median(approximate)}
    return result


def check_examples(checkers):
    examples = read(ROOT / 'examples/v0.1/records.json')
    for kind, record in examples.items():
        checkers['event-envelope' if kind == 'envelope' else kind].validate(record)
    envelope = examples['envelope']
    checkers[envelope['record_type']].validate(envelope['payload'])


def main():
    checkers = validators()
    check_examples(checkers)
    cases = ROOT / 'conformance/v0.1'
    structural = semantic = comparisons = invariants = 0
    for path in sorted((cases / 'cases').glob('*.json')):
        data = read(path)
        checkers['dataset'].validate(data)
        structural += 1
        data = normalise(data)
        semantic += 1
        expected = read(cases / 'expected-results' / path.name)
        expected_results = expected if isinstance(expected, list) else [expected]
        actual_results = [calculate(data, service['id']) for service in data['services']]
        for result in expected_results + actual_results:
            checkers['metric-result'].validate(result)
        if actual_results != expected_results:
            raise ValueError(f'{path.name}: calculation mismatch\nactual={json.dumps(actual_results, indent=2)}')
        comparisons += len(actual_results)
        reversed_data = copy.deepcopy(data)
        for plural in KINDS:
            reversed_data[plural].reverse()
        reversed_results = [calculate(normalise(reversed_data), service['id'])
                            for service in reversed_data['services']]
        key = lambda result: result['service_id']
        if sorted(actual_results, key=key) != sorted(reversed_results, key=key):
            raise ValueError(f'{path.name}: record ordering changed results')
        invariants += 1
    for path in sorted((cases / 'invalid').glob('*.json')):
        case = read(path)
        if case['layer'] == 'structural':
            errors = list(checkers[case.get('schema', 'dataset')].iter_errors(case['input']))
            if not errors:
                raise ValueError(f'{path.name}: expected structural rejection')
            structural += 1
        else:
            checkers['dataset'].validate(case['input'])
            structural += 1
            try:
                normalise(case['input'])
            except SemanticError as error:
                if error.code != case['error_code']:
                    raise ValueError(f'{path.name}: expected {case["error_code"]}, got {error.code}') from error
            else:
                raise ValueError(f'{path.name}: expected semantic rejection')
            semantic += 1
    print(f'Structural: {len(checkers)} schemas, examples/payload, {structural} fixture checks passed')
    print(f'Semantic: {semantic} valid/rejection fixture checks passed')
    print(f'Calculation: {comparisons} service results matched explicit expectations')
    print(f'Invariance: {invariants} reordered datasets produced identical service results')


if __name__ == '__main__':
    main()
