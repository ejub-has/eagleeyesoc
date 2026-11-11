import { useState, type KeyboardEvent } from 'react'

/** Free-form tags: type and press Enter or comma to add; remove with the x on a tag. */
export function TagInput({
  value,
  onChange,
  disabled,
}: {
  value: string[]
  onChange: (tags: string[]) => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')

  function add() {
    const tag = text.trim().replace(/,$/, '').trim()
    setText('')
    if (tag && !value.some((t) => t.toLowerCase() === tag.toLowerCase())) onChange([...value, tag])
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      add()
    } else if (event.key === 'Backspace' && text === '' && value.length) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div className="tag-input">
      {value.map((tag) => (
        <span key={tag} className="tag-chip">
          {tag}
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(value.filter((t) => t !== tag))}
            >
              x
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          aria-label="Add tag"
          placeholder={value.length ? 'Add tag' : 'Add a tag and press Enter'}
          maxLength={100}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={add}
        />
      )}
    </div>
  )
}
