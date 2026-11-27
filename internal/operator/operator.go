package operator

import (
	"fmt"
	"io"
	"sort"
)

// commands is the single dispatch table shared by the server binary and the
// development wrappers under cmd/. Keeping it here means a new maintenance
// command becomes reachable as `practacu-press <name>` by adding one entry.
var commands = map[string]func([]string) error{
	"migrate":     Migrate,
	"seed":        Seed,
	"backup":      Backup,
	"media-gc":    MediaGC,
	"searchindex": SearchIndex,
}

// Known reports whether name is a maintenance subcommand.
func Known(name string) bool {
	_, ok := commands[name]
	return ok
}

// Run executes the named subcommand in-process.
func Run(name string, args []string) error {
	command, ok := commands[name]
	if !ok {
		return fmt.Errorf("unknown command %q", name)
	}
	return command(args)
}

// Commands lists the subcommands in a stable order for help output.
func Commands() []string {
	names := make([]string, 0, len(commands))
	for name := range commands {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Usage writes the command summary shared by `practacu-press help` and the
// process banner of an unknown subcommand.
func Usage(w io.Writer) {
	fmt.Fprint(w, `Practacu Press

Usage:
  practacu-press                     start the HTTP API and the dashboard
  practacu-press <command> [flags]   run a maintenance command in-process

Commands:
  migrate       apply the persistence schema
  seed          create the default site and print its id
  backup        create, verify or restore a backup package
  media-gc      remove media objects no database row references
  searchindex   report or rebuild the full text search index

Run "practacu-press <command> --help" for the flags of one command.
`)
}
