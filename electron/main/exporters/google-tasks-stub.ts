import type { Exporter } from './interface';

export class GoogleTasksStub implements Exporter {
  name = 'google-tasks';
  async export(): Promise<string> {
    throw new Error('Google Tasks exporter not implemented yet');
  }
}
