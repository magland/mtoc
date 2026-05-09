s = "hello";
disp(length(s));
disp(numel(s));

% length of any string is 1 in numbl, regardless of byte count
big = "abcdefghij";
disp(length(big));
disp(numel(big));

empty = "";
disp(length(empty));
disp(numel(empty));
