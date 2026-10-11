import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildArtifact,
  observeArtifact,
  provenanceEvent,
  publishEvidence,
  publishNative,
  readArtifact,
  readJson,
  renderManifest,
  saveBaseline,
  saveEvidence,
  saveHealth,
  saveNativeNotification,
} from './producers.ts';

export async function main(args: string[]): Promise<void> {
  const [command, ...values] = args;
  if (command === 'build' && values.length === 4) {
    const [gitDirectory, commitSha, repositoryId, outputDirectory] = values;
    if (!gitDirectory || !commitSha || !repositoryId || !outputDirectory)
      throw new Error('invalid_arguments');
    const receipt = await buildArtifact({ gitDirectory, commitSha, repositoryId, outputDirectory });
    console.log(JSON.stringify(receipt));
  } else if (command === 'baseline' && values.length === 3) {
    const [endpoint, operationId, outputFile] = values;
    if (!endpoint || !operationId || !outputFile) throw new Error('invalid_arguments');
    await saveBaseline(endpoint, operationId, outputFile);
    console.log(outputFile);
  } else if (command === 'health' && values.length === 4) {
    const [endpoint, operationId, artifactDigest, outputFile] = values;
    if (!endpoint || !operationId || !artifactDigest || !outputFile)
      throw new Error('invalid_arguments');
    await saveHealth(endpoint, operationId, artifactDigest, outputFile);
    console.log(outputFile);
  } else if (command === 'native' && (values.length === 2 || values.length === 3)) {
    const [applicationFile, outputFile, expectedOperationId] = values;
    if (!applicationFile || !outputFile) throw new Error('invalid_arguments');
    await saveNativeNotification(applicationFile, outputFile, expectedOperationId);
    console.log(outputFile);
  } else if (command === 'provenance' && values.length === 4) {
    const [artifactDirectory, sourceId, producerId, outputDirectory] = values;
    if (!artifactDirectory || !sourceId || !producerId || !outputDirectory)
      throw new Error('invalid_arguments');
    const { bytes, receipt } = await readArtifact(artifactDirectory);
    await saveEvidence(outputDirectory, provenanceEvent(bytes, receipt, { sourceId, producerId }));
    console.log(join(outputDirectory, 'event.json'));
  } else if (command === 'observe' && values.length === 7) {
    const [
      artifactDirectory,
      notificationFile,
      baselineFile,
      endpoint,
      sourceId,
      producerId,
      outputDirectory,
    ] = values;
    if (
      !artifactDirectory ||
      !notificationFile ||
      !baselineFile ||
      !endpoint ||
      !sourceId ||
      !producerId ||
      !outputDirectory
    )
      throw new Error('invalid_arguments');
    const { bytes, receipt } = await readArtifact(artifactDirectory);
    const { event, observation } = await observeArtifact({
      bytes,
      receipt,
      notification: await readJson(notificationFile),
      baseline: await readJson(baselineFile),
      endpoint,
      producer: { sourceId, producerId },
    });
    await saveEvidence(outputDirectory, event, observation);
    console.log(join(outputDirectory, 'event.json'));
  } else if (command === 'native-publish' && values.length === 4) {
    const [notificationFile, baseUrl, sourceId, tokenFile] = values;
    if (!notificationFile || !baseUrl || !sourceId || !tokenFile)
      throw new Error('invalid_arguments');
    const status = await publishNative({
      notification: await readJson(notificationFile),
      baseUrl,
      sourceId,
      tokenFile,
    });
    console.log(`Receiver HTTP ${status}; retained notification: ${notificationFile}`);
    if (status < 200 || status >= 300) process.exitCode = 1;
  } else if (command === 'publish' && values.length === 3) {
    const [eventFile, baseUrl, tokenFile] = values;
    if (!eventFile || !baseUrl || !tokenFile) throw new Error('invalid_arguments');
    const status = await publishEvidence({ event: await readJson(eventFile), baseUrl, tokenFile });
    console.log(`Receiver HTTP ${status}; retained event: ${eventFile}`);
    if (status < 200 || status >= 300) process.exitCode = 1;
  } else if (command === 'render' && values.length >= 2 && values.length <= 4) {
    const [artifactDirectory, nginxImage, scenario, sandboxNamespace] = values;
    if (!artifactDirectory || !nginxImage) throw new Error('invalid_arguments');
    const { bytes, receipt } = await readArtifact(artifactDirectory);
    console.log(renderManifest(bytes, receipt, nginxImage, scenario, sandboxNamespace));
  } else {
    throw new Error(
      'usage: native-publish NOTIFICATION_JSON CLIO_HTTP_ORIGIN SOURCE_UUID TOKEN_FILE | baseline HTTP_INDEX_URL OPERATION_UUID OUTPUT_JSON | health HTTP_HEALTHZ_URL OPERATION_UUID ARTIFACT_DIGEST OUTPUT_JSON | native APPLICATION_JSON OUTPUT_JSON [EXPECTED_OPERATION_UUID] | build GIT_DIR COMMIT_SHA REPOSITORY_ID OUTPUT_DIR | provenance ARTIFACT_DIR SOURCE_UUID PRODUCER_UUID OUTPUT_DIR | observe ARTIFACT_DIR NOTIFICATION_JSON BASELINE_JSON HTTP_INDEX_URL SOURCE_UUID PRODUCER_UUID OUTPUT_DIR | publish EVENT_JSON CLIO_HTTP_ORIGIN TOKEN_FILE | render ARTIFACT_DIR NGINX_IMAGE_AT_SHA256 [healthy|broken|recovery] [CLIO_LIFECYCLE_NAMESPACE]',
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'Demo command failed. Check arguments, committed artifact, operation binding, endpoint and private file permissions.',
    );
    process.exitCode = 1;
  });
}
