% Multi-output user functions with mixed scalar + tensor outputs.

function [s, c] = stats(x)
  s = sum(x);
  m = s ./ numel(x);
  c = x - m;
end

function [a, b] = both(x)
  a = x .* 2;
  b = x + 100;
end

% Mixed scalar + tensor output
v = [1 2 3 4];
[total, centered] = stats(v);
disp(total);
disp(centered);

% Two tensor outputs
[d, e] = both(v);
disp(d);
disp(e);

% Discard the tensor: ~ for tensor slot
[only_s, ~] = stats(v);
disp(only_s);

% Discard the scalar: ~ for scalar slot
[~, only_c] = stats(v);
disp(only_c);

% Drop everything — bare statement form
both(v);
disp(v);  % original unchanged
