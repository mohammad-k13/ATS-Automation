import {
      anthropicChat,
      KeywordScorer,
      LlmScorer,
      openAICompatChat,
      toComplete,
      type Chat,
      type Scorer,
} from '../domain/score';

export interface AiInfo {
      provider: 'omniroute' | 'anthropic' | 'keyword';
      model: string | null;
}

export function aiInfo(env: NodeJS.ProcessEnv = process.env): AiInfo {
      const p = (
            env.AI_PROVIDER ||
            (env.OMNIROUTE_BASE_URL ? 'omniroute' : env.ANTHROPIC_API_KEY ? 'anthropic' : '')
      ).toLowerCase();
      if (p === 'omniroute' && env.OMNIROUTE_BASE_URL && env.OMNIROUTE_MODEL)
            return { provider: 'omniroute', model: env.OMNIROUTE_MODEL };
      if (p === 'anthropic' && env.ANTHROPIC_API_KEY)
            return { provider: 'anthropic', model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5' };
      return { provider: 'keyword', model: null };
}

/** Chat function for the configured provider, or null if no AI is configured. */
export function getChat(env: NodeJS.ProcessEnv = process.env): Chat | null {
      const ai = aiInfo(env);
      if (ai.provider === 'omniroute')
            return openAICompatChat(
                  env.OMNIROUTE_BASE_URL!,
                  env.OMNIROUTE_API_KEY ?? '',
                  ai.model!,
            );
      if (ai.provider === 'anthropic') return anthropicChat(env.ANTHROPIC_API_KEY!, ai.model!);
      return null;
}

export function getScorer(env: NodeJS.ProcessEnv = process.env): Scorer {
      const chat = getChat(env);
      return chat ? new LlmScorer(toComplete(chat)) : new KeywordScorer();
}
