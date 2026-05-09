% Escaped double-quote: numbl uses doubled "" to embed a literal "
quoted = "say ""hi""";
disp(quoted);

% Embedded backslash and tab — numbl strings are byte-transparent
back = "a\tb";
disp(back);

% Empty string concat behavior
joined = "" + "abc";
disp(joined);
disp(length(joined));
