-- Float only the main Ham Study window (installed binary or bundled build).
hl.window_rule({
  match = { initial_class = "^(ham-study|ham-study-desktop|ca[.]hamstudy[.]desktop)$", initial_title = "^Ham Study$" },
  float = true,
})
