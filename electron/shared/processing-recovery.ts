export function processingDiagnosis(error: string | null | undefined): { title: string; action: string; section: string } {
  const text = (error ?? '').toLowerCase();
  if (/reasoning.loop|thinking.*loop|token budget/.test(text)) return { title: 'The summary model did not finish its answer', action: 'Disable model thinking or choose a smaller model, then retry.', section: 'Processing' };
  if (/401|403|gated|access.*denied|token.*missing|hugging.*token/.test(text)) return { title: 'A processing service needs access', action: 'Check model access and authentication in Setup & health, then retry.', section: 'Processing' };
  if (/model.*not.*(found|installed)|no whisper model|model.*missing|custom whisper/.test(text)) return { title: 'The transcription model is unavailable', action: 'Install or select a Whisper model in Processing Settings, then retry.', section: 'Processing' };
  if (/moov|invalid.*(media|audio)|no usable duration|decode|zero vector/.test(text)) return { title: 'This recording could not be analyzed', action: 'Play the original audio first. Check capture recovery or try a usable shorter copy before retrying.', section: 'Recording' };
  if (/econn|fetch failed|not ready|timed? out|connection|unreachable|spawn|binary.*not found/.test(text)) return { title: 'A processing service is not ready', action: 'Check the configured provider and endpoint in Setup & health, then retry.', section: 'Processing' };
  if (/memory|oom|metal|channel error/.test(text)) return { title: 'The model ran out of available resources', action: 'Choose a smaller model or close other model workloads, then retry.', section: 'Processing' };
  return { title: 'Processing could not finish', action: 'Review technical details, check Setup & health, and retry the failed step.', section: 'Processing' };
}

export function primaryProcessingStatus(input: { status: string; pipelineStage: string; summaryStale?: boolean }): 'failure' | 'speaker' | 'advisory' | null {
  if (input.status === 'failed') return 'failure';
  if (input.status === 'awaiting_user' && input.pipelineStage === 'awaiting_speaker_id') return 'speaker';
  return input.summaryStale ? 'advisory' : null;
}
