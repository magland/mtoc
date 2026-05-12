% Cross-runner coverage for complex `while` conditions. numbl's
% toBool on complex: `creal(z) != 0 || cimag(z) != 0`.

% Start with a complex value, decrement the real lane until the cond
% goes false (both lanes zero). The body keeps z complex so the loop
% cond stays scalar complex through the whole life of the loop.
z = 3 + 0i;
while z
  disp(z);
  z = z - (1 + 0i);
end
disp(99);

% Pure-imag complex — single iteration body, then we zero both lanes.
w = 0 + 1i;
while w
  disp(w);
  w = 0 + 0i;
end
disp(100);
