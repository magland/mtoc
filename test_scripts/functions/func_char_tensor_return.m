% Char-tensor returns (mtoc_char_tensor_t).

function s = greet_chars()
  s = 'hello';
end

function s = letters()
  s = 'abcde';
end

h = greet_chars();
disp(h);

ab = letters();
disp(ab);

% Multi-output mixing scalar + char tensor
function [n, c] = labeled(k)
  c = 'item';
  n = k + 1;
end

[idx, label] = labeled(7);
disp(idx);
disp(label);
