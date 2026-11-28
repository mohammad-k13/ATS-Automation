'use client';
import { useState } from 'react';

export default function TagsInput({
    value,
    onChange,
    placeholder,
}: {
    value: string[];
    onChange: (v: string[]) => void;
    placeholder?: string;
}) {
    const [text, setText] = useState('');
    const add = () => {
        const parts = text
            .split(/[,،\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((s) => !value.includes(s));
        if (parts.length) onChange([...value, ...parts]);
        setText('');
    };
    return (
        <div className="tags">
            {value.map((t) => (
                <span className="tag" key={t}>
                    {t}
                    <button type="button" aria-label="حذف" onClick={() => onChange(value.filter((x) => x !== t))}>
                        ×
                    </button>
                </span>
            ))}
            <input
                value={text}
                placeholder={value.length ? '' : placeholder}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        add();
                    }
                    if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
                }}
                onBlur={add}
            />
        </div>
    );
}
