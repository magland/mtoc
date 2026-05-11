% A 1-output user function returning a real tensor.

function y = bump(x)
  y = x + 1;
end

function y = squared(x)
  y = x .* x;
end

function y = scale(x, k)
  y = x .* k;
end

a = [1 2 3 4];
b = bump(a);
disp(b);
disp(a);  % unchanged — copy-on-arg-pass

src = [5 6 7 8];
sq = squared(src);
disp(sq);

% Tensor return composed with tensor return — assign each step.
m = [1 2; 3 4];
m2 = scale(m, 10);
disp(m2);
m3 = squared(m2);
disp(m3);

% Column vector
cv = [3; 4; 12];
cv_b = bump(cv);
disp(cv_b);
