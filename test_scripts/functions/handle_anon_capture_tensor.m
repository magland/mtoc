v = [1 2 3 4];
f = @(i) v(i);
disp(f(1));
disp(f(3));

% Tensor reassignment does NOT affect the snapshot
v = [99 99 99 99];
disp(f(2));

% Capture a tensor and pass through a higher-order function
w = [10 20 30];
g = @(i) w(i) + 100;
disp(apply(g, 2));

function r = apply(h, i)
  r = h(i);
end
