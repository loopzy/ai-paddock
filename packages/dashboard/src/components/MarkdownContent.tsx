import type { ReactNode } from 'react';

type MarkdownBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'unordered-list'; items: string[] }
  | { type: 'ordered-list'; items: string[] }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'code'; language?: string; text: string };

function parseBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = line.match(/^```([\w-]+)?\s*$/);
    if (codeFence) {
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: 'code',
        language: codeFence[1],
        text: codeLines.join('\n'),
      });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: heading[2].trim(),
      });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*+]\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'unordered-list', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+\.\s+/, '').trim());
        index += 1;
      }
      blocks.push({ type: 'ordered-list', items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !/^(#{1,6})\s+/.test(lines[index] ?? '') &&
      !/^```/.test(lines[index] ?? '') &&
      !/^>\s?/.test(lines[index] ?? '') &&
      !/^\s*[-*+]\s+/.test(lines[index] ?? '') &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? '')
    ) {
      paragraphLines.push((lines[index] ?? '').trim());
      index += 1;
    }

    blocks.push({
      type: 'paragraph',
      text: paragraphLines.join(' '),
    });
  }

  return blocks;
}

function renderInline(source: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(source.slice(lastIndex, match.index));
    }

    if (match[2] && match[3]) {
      nodes.push(
        <a
          key={`${keyPrefix}-link-${match.index}`}
          href={match[3]}
          target="_blank"
          rel="noreferrer"
          className="text-sky-700 underline decoration-sky-300 underline-offset-2"
        >
          {match[2]}
        </a>,
      );
    } else if (match[4]) {
      nodes.push(
        <code
          key={`${keyPrefix}-code-${match.index}`}
          className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[0.95em] text-stone-700"
        >
          {match[4]}
        </code>,
      );
    } else if (match[5] || match[6]) {
      nodes.push(<strong key={`${keyPrefix}-strong-${match.index}`}>{match[5] ?? match[6]}</strong>);
    } else if (match[7] || match[8]) {
      nodes.push(<em key={`${keyPrefix}-em-${match.index}`}>{match[7] ?? match[8]}</em>);
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < source.length) {
    nodes.push(source.slice(lastIndex));
  }

  return nodes;
}

export function MarkdownContent({
  content,
  className = '',
}: {
  content: string;
  className?: string;
}) {
  const blocks = parseBlocks(content);

  return (
    <div className={`space-y-3 break-words ${className}`.trim()}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case 'heading': {
            const headingClass =
              block.level <= 2
                ? 'text-base font-semibold text-stone-950'
                : block.level === 3
                  ? 'text-sm font-semibold text-stone-900'
                  : 'text-sm font-medium text-stone-800';
            return (
              <div key={key} className={headingClass}>
                {renderInline(block.text, key)}
              </div>
            );
          }
          case 'unordered-list':
            return (
              <ul key={key} className="list-disc space-y-1 pl-5 text-sm leading-7 text-stone-900">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ul>
            );
          case 'ordered-list':
            return (
              <ol key={key} className="list-decimal space-y-1 pl-5 text-sm leading-7 text-stone-900">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ol>
            );
          case 'blockquote':
            return (
              <blockquote key={key} className="border-l-2 border-stone-300 pl-4 text-sm leading-7 text-stone-600">
                {block.lines.map((line, lineIndex) => (
                  <p key={`${key}-${lineIndex}`}>{renderInline(line, `${key}-${lineIndex}`)}</p>
                ))}
              </blockquote>
            );
          case 'code':
            return (
              <div key={key} className="overflow-x-auto rounded-2xl border border-stone-200 bg-stone-950/95 px-4 py-3">
                {block.language && (
                  <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-stone-400">{block.language}</div>
                )}
                <pre className="whitespace-pre-wrap text-[12px] leading-6 text-stone-100">{block.text}</pre>
              </div>
            );
          case 'paragraph':
            return (
              <p key={key} className="text-sm leading-7 text-stone-900">
                {renderInline(block.text, key)}
              </p>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
