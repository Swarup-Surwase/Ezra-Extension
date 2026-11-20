import { TurnStreamingEvent } from './types';

export class SSEStreamParser {
  private buffer = '';

  public parseChunk(chunk: string, onEvent: (event: TurnStreamingEvent) => void): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() ?? '';

    let currentEvent = '';
    let currentData = '';

    for (const line of lines) {
      if (line.trim() === '') {
        // Event boundary
        if (currentData.trim() !== '') {
          try {
            const parsed = JSON.parse(currentData.trim());
            onEvent(parsed);
          } catch (e) {
            // Log or ignore malformed event without crashing
            console.warn('[SSEStreamParser] Malformed event payload:', currentData, e);
          }
          currentData = '';
          currentEvent = '';
        }
      } else if (line.startsWith('event:')) {
        currentEvent = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        const dataPart = line.substring(5).trim();
        currentData = currentData ? currentData + '\n' + dataPart : dataPart;
      }
    }
  }

  public flush(onEvent: (event: TurnStreamingEvent) => void): void {
    if (this.buffer.trim() !== '') {
      const dataMatch = this.buffer.match(/^data:\s*(.*)$/m);
      const raw = dataMatch ? dataMatch[1].trim() : this.buffer.trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          onEvent(parsed);
        } catch {
          // Ignore trailing incomplete fragment
        }
      }
      this.buffer = '';
    }
  }
}

