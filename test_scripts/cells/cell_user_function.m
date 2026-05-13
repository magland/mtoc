% Cells as user-function parameters and returns. The tuple cell's
% per-shape typedef rides on the call's specialization key, and the
% return-by-value path uses the typedef's _assign helper.
c = {10, 20, 30};
disp(sum_cell(c));
b = build_cell(7);
disp(b{1});
disp(b{2});

function s = sum_cell(c)
  s = c{1} + c{2} + c{3};
end

function out = build_cell(k)
  out = {k, k * k};
end
