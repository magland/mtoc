% Early returns + reassignments of the tensor output.

function y = clamp_or_abs(x, threshold)
  if threshold > 0
    y = abs(x);
    return;
  end
  y = x;
end

% Reassign the tensor output multiple times — same coarse shape so
% storage is reused via mtoc_tensor_assign at each step.
function y = build(n)
  y = [1 2 3];
  if n > 1
    y = y .* 2;
  end
  if n > 2
    y = y + 100;
  end
end

src = [-1 2 -3 4];
a = clamp_or_abs(src, 1);
disp(a);

b = clamp_or_abs(src, 0);
disp(b);

c = build(0);
disp(c);
d = build(1);
disp(d);
e = build(2);
disp(e);
f = build(3);
disp(f);
