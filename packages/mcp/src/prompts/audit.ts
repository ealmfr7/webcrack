import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// TODO(M3.2): refine with what the evals show works best.
export function registerAuditPrompt(server: McpServer): void {
  server.registerPrompt(
    'audit',
    {
      title: 'Audit a JavaScript bundle',
      description:
        'Guided reverse-engineering workflow over a bundle or obfuscated script.',
      argsSchema: {
        source: z.string().describe('File path, URL or code to analyze.'),
        goal: z
          .string()
          .optional()
          .describe('What to find out, e.g. "how requests are signed".'),
      },
    },
    ({ source, goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Reverse engineer ${source} with the webcrack tools.`,
              goal ? `Goal: ${goal}` : 'Goal: a security-oriented overview.',
              '',
              '1. wc_open the source and read the overview.',
              '2. wc_findings category=summary, then the relevant categories.',
              '3. wc_map (filter by tag) to spot the interesting modules.',
              '4. For each lead: wc_read, wc_goto, wc_refs to follow it.',
              '5. wc_deobfuscate anything still obfuscated.',
              '6. wc_annotate names and notes as you understand code.',
              '7. Finish with a report citing module:line for every claim.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
