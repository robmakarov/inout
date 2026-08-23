export function RecordButton({
  recording,
  arming,
  disabled,
  onClick,
}: {
  recording: boolean
  arming: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`recbtn${arming ? ' recbtn--arming' : ''}`}
      // Never disabled while arming: a device that takes its time must not
      // leave the user with nothing to press. Arming state = cancel.
      disabled={disabled}
      onClick={onClick}
      aria-label={
        arming ? 'Cancel starting' : recording ? 'Stop recording' : 'Start recording'
      }
      title={disabled ? 'Turn on at least one input' : arming ? 'Cancel' : undefined}
    >
      <span className={`recbtn__inner${recording ? ' recbtn__inner--stop' : ''}`} />
    </button>
  )
}
