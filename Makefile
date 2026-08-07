.PHONY: ship

# Stage all changes except secret env files, commit with a prompt, then push.
# Keeps *.env.example tracked; skips .env / .env.* (and nested paths).
ship:
	@git status --short
	@echo
	@printf "Комментарий коммита: "
	@read msg; \
	if [ -z "$$msg" ]; then \
		echo "Пустой комментарий — отмена."; \
		exit 1; \
	fi; \
	git add -A && \
	for f in $$(git diff --cached --name-only); do \
		case "$$f" in \
			.env|.env.*|*/.env|*/.env.*) \
				case "$$f" in \
					*.example) ;; \
					*) git reset -q -- "$$f" ;; \
				esac ;; \
		esac; \
	done && \
	git commit -m "$$msg" && \
	git push
