// oxlint-disable t3code/no-untranslated-copy -- the fork UI is English-only.
import type { JjLogRow, JjRevsetAlias } from "@t3tools/contracts";
import { type KeyboardEvent, type SyntheticEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import {
  applyJjRevsetSuggestion,
  jjRevsetSuggestions,
  type JjRevsetSuggestion,
} from "./jj-revset-completion";

/** The revset field, completing jj functions, aliases, bookmarks and tags, with common presets. */
export const JjRevsetInput = (props: {
  value: string;
  edited: boolean;
  placeholder: string;
  aliases: ReadonlyArray<JjRevsetAlias>;
  rows: ReadonlyArray<JjLogRow>;
  onChange: (value: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(props.value.length);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState<JjRevsetSuggestion | undefined>();
  const suggestions = jjRevsetSuggestions({
    text: props.value,
    caret,
    edited: props.edited,
    aliases: props.aliases,
    rows: props.rows,
  });
  const showing = open && suggestions.length > 0;

  // `onSelect` misses some edits, so read the caret from the input whenever it matters.
  const liveCaret = () => inputRef.current?.selectionStart ?? caret;
  const accept = (suggestion: JjRevsetSuggestion) => {
    const next = applyJjRevsetSuggestion({ text: props.value, caret: liveCaret(), suggestion });
    // The caret can only move once the input holds the new text.
    flushSync(() => props.onChange(next.text));
    inputRef.current?.setSelectionRange(next.caret, next.caret);
    setCaret(next.caret);
  };
  const syncCaret = (event: SyntheticEvent<HTMLInputElement>) =>
    setCaret(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab" && showing) {
      // Tab completes the first suggestion, but never swaps the whole revset for a preset.
      const target = highlighted ?? suggestions.find((suggestion) => suggestion.kind !== "preset");
      if (!target) return;
      event.preventDefault();
      accept(target);
      return;
    }
    // With a highlighted suggestion, Enter and Escape belong to the list.
    if (showing && (event.key === "Escape" || highlighted)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      setOpen(false);
      props.onApply();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    }
  };

  return (
    <Autocomplete
      items={suggestions}
      mode="none"
      value={props.value}
      open={showing}
      openOnInputClick
      onOpenChange={setOpen}
      itemToStringValue={(suggestion) => suggestion.id}
      onItemHighlighted={setHighlighted}
      onValueChange={(value, details) => {
        if (details.reason === "item-press") {
          const suggestion = suggestions.find((candidate) => candidate.id === value);
          if (suggestion) accept(suggestion);
          return;
        }
        if (details.reason === "escape-key") return props.onCancel();
        props.onChange(value);
        setCaret(liveCaret());
      }}
    >
      <AutocompleteInput
        ref={inputRef}
        size="sm"
        aria-label="Revset"
        spellCheck={false}
        placeholder={props.placeholder}
        onSelect={syncCaret}
        onKeyDown={onKeyDown}
      />
      <AutocompletePopup>
        <AutocompleteList>
          {(suggestion: JjRevsetSuggestion) => (
            <AutocompleteItem key={suggestion.id} value={suggestion}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-xs">{suggestion.label}</span>
                <span className="truncate text-muted-foreground text-xs">{suggestion.detail}</span>
              </span>
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  );
};
