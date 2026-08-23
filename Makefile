SHELL = /bin/sh

INSTALLER = ./scripts/install-agent-integrations.sh

.PHONY: install install-codex install-claude update doctor uninstall

install:
	@$(INSTALLER) install all

install-codex:
	@$(INSTALLER) install codex

install-claude:
	@$(INSTALLER) install claude

update:
	@$(INSTALLER) update all

doctor:
	@$(INSTALLER) doctor

uninstall:
	@$(INSTALLER) uninstall
