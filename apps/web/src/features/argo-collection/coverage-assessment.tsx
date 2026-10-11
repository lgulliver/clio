import type { CoverageAssessment as Assessment } from './api';

export function CoverageAssessment({ assessment }: { assessment: Assessment | undefined }) {
  return (
    <section aria-label="Coverage evidence needed" className="space-y-2">
      <h3 className="font-semibold">Evidence needed for complete coverage</h3>
      {assessment ? (
        <>
          <p>This assessment was saved at the result's evidence cutoff.</p>
          <dl className="space-y-2">
            <div>
              <dt className="font-medium">Deployment population</dt>
              <dd>
                An authoritative census covering every production deployment path for this service
                and reporting window is missing. Recorded qualifying deployments in window:{' '}
                {assessment.windowPopulationCount}. Unknown qualification across retained history:{' '}
                {assessment.unresolvedQualificationCount}.
              </dd>
            </div>
            <div>
              <dt className="font-medium">First deployment and change history</dt>
              <dd>
                Complete relevant history before the reporting window and exact application change
                links are missing. Qualifying deployments before window end:{' '}
                {assessment.historyQualifyingCount}. Incomplete change links:{' '}
                {assessment.incompleteChangeLinkCount}. Build provenance alone does not enumerate
                changes.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Failure and recovery</dt>
              <dd>
                Production failure classification, causal incident links and service restoration
                evidence are missing. Window deployments with unknown failure classification:{' '}
                {assessment.unknownFailureCount}. Unknown rework classification:{' '}
                {assessment.unknownReworkCount}.
              </dd>
            </div>
          </dl>
          <p>Zero recorded deployments or gaps does not establish complete coverage.</p>
        </>
      ) : (
        <p>
          This older result has no saved coverage assessment. Missing assessment does not mean
          complete coverage. Save a new collection result to assess current evidence.
        </p>
      )}
    </section>
  );
}
