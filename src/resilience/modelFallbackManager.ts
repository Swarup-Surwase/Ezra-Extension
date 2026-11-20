import * as vscode from 'vscode';
import { TrueForgeClient } from '../transport/TrueForgeClient';
import { getConfig } from '../config';

export interface FallbackStatus {
  isFallback: boolean;
  activeModel: string;
  primaryModel: string;
  fallbackModel?: string;
  warning?: string;
  reason?: string;
}

export class ModelFallbackManager {
  private client: TrueForgeClient;
  private currentStatus: FallbackStatus;
  private _onDidTriggerFallback = new vscode.EventEmitter<FallbackStatus>();
  public readonly onDidTriggerFallback = this._onDidTriggerFallback.event;

  constructor(client: TrueForgeClient) {
    this.client = client;
    const cfg = getConfig();
    this.currentStatus = {
      isFallback: false,
      activeModel: cfg.modelName,
      primaryModel: cfg.modelName,
      fallbackModel: cfg.fallbackModelName,
    };
  }

  public getStatus(): FallbackStatus {
    return { ...this.currentStatus };
  }

  public reset(): void {
    const cfg = getConfig();
    this.currentStatus = {
      isFallback: false,
      activeModel: cfg.modelName,
      primaryModel: cfg.modelName,
      fallbackModel: cfg.fallbackModelName,
    };
  }

  /**
   * Evaluates if a model failure can trigger automatic fallback to a secondary configured model in TrueForge.
   * If a second model is configured in TrueForge, returns the fallback model name and logs a clear warning.
   * If no second model is configured, returns undefined and reports the honest failure.
   */
  public async handleModelFailure(error: any): Promise<string | undefined> {
    const cfg = getConfig();
    const primary = cfg.modelName;
    const fallback = cfg.fallbackModelName;

    // Query models actually configured in TrueForge
    let configuredModels: string[] = [];
    try {
      configuredModels = await this.client.listConfiguredModels();
    } catch {
      // If server unreachable, no fallback possible
      return undefined;
    }

    // Check if fallback model is actually configured or available in TrueForge
    const hasSecondaryModel = configuredModels.length > 1 || configuredModels.includes(fallback);

    if (!hasSecondaryModel && configuredModels.length <= 1) {
      // Honest failure: do not pretend fallback succeeded when TrueForge has no second model
      this.currentStatus = {
        isFallback: false,
        activeModel: primary,
        primaryModel: primary,
        warning: `Primary model "${primary}" failed (${error?.message || String(error)}). No secondary model is configured in TrueForge.`,
      };
      this._onDidTriggerFallback.fire(this.currentStatus);
      return undefined;
    }

    // Fallback is configured in TrueForge! Select configured secondary model
    const selectedFallback = configuredModels.includes(fallback)
      ? fallback
      : configuredModels.find((m) => m !== primary) || fallback;

    this.currentStatus = {
      isFallback: true,
      activeModel: selectedFallback,
      primaryModel: primary,
      fallbackModel: selectedFallback,
      reason: error?.message || 'Model call failed',
      warning: `Primary model "${primary}" failed (${error?.message || 'Inference error'}). Automatically falling back to configured TrueForge model "${selectedFallback}".`,
    };

    vscode.window.showWarningMessage(
      `[TrueForge] ${this.currentStatus.warning}`
    );

    this._onDidTriggerFallback.fire(this.currentStatus);
    return selectedFallback;
  }
}

