import { useState } from 'react';

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

export function ExpandableTextBlock({
  content,
  previewChars = 320,
  expandLabel = 'Expand full text',
  collapseLabel = 'Collapse text',
  preserveWhitespace = false,
  className = '',
  textClassName = '',
  buttonClassName = '',
}: {
  content: string;
  previewChars?: number;
  expandLabel?: string;
  collapseLabel?: string;
  preserveWhitespace?: boolean;
  className?: string;
  textClassName?: string;
  buttonClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const normalized = normalizeContent(content);
  const shouldCollapse = normalized.length > previewChars;
  const preview = shouldCollapse ? `${normalized.slice(0, previewChars).trimEnd()}…` : normalized;
  const textValue = expanded || !shouldCollapse ? normalized : preview;
  const whitespaceClass = preserveWhitespace ? 'whitespace-pre-wrap break-words' : 'break-words';
  const textClasses = [whitespaceClass, textClassName].filter(Boolean).join(' ');
  const buttonClasses = [
    'rounded-full border border-stone-200 bg-white px-3 py-1 text-[11px] font-medium text-stone-500 transition hover:border-stone-300 hover:text-stone-900',
    buttonClassName,
  ].filter(Boolean).join(' ');

  return (
    <div className={className}>
      <div className={textClasses}>{textValue}</div>
      {shouldCollapse && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className={buttonClasses}
          >
            {expanded ? collapseLabel : expandLabel}
          </button>
        </div>
      )}
    </div>
  );
}
